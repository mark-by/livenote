use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

use super::{ConnectionError, Provider, Result, transport};

/// Идентификатор открытого vault из реестра сервиса.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct VaultId(String);

impl VaultId {
    pub fn new(value: &str) -> Result<Self> {
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(ConnectionError::Invalid);
        }
        Ok(Self(value.into()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    Model,
    Confluence,
    Gitlab,
    Github,
}

impl From<Provider> for Slot {
    fn from(value: Provider) -> Self {
        match value {
            Provider::Confluence => Self::Confluence,
            Provider::Gitlab => Self::Gitlab,
            Provider::Github => Self::Github,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Profile {
    Model {
        base_url: String,
        model: String,
    },
    Confluence {
        endpoint: String,
        resource_host: String,
    },
    Gitlab {
        endpoint: String,
        resource_host: String,
    },
    Github {
        endpoint: String,
        resource_host: String,
    },
}

impl Profile {
    pub const fn slot(&self) -> Slot {
        match self {
            Self::Model { .. } => Slot::Model,
            Self::Confluence { .. } => Slot::Confluence,
            Self::Gitlab { .. } => Slot::Gitlab,
            Self::Github { .. } => Slot::Github,
        }
    }

    fn destination(&self) -> (&str, Option<&str>) {
        match self {
            Self::Model { base_url, .. } => (base_url, None),
            Self::Confluence {
                endpoint,
                resource_host,
            }
            | Self::Gitlab {
                endpoint,
                resource_host,
            }
            | Self::Github {
                endpoint,
                resource_host,
            } => (endpoint, Some(resource_host)),
        }
    }

    pub(super) fn addresses(&self) -> Result<(Url, Option<Url>)> {
        let (address, host) = self.destination();
        let endpoint = transport::endpoint(address)?;
        let site = host
            .map(|host| {
                if host.is_empty() || host.contains(['/', '\\', '@', '?', '#', ' ']) {
                    return Err(ConnectionError::Invalid);
                }
                let site = transport::endpoint(&format!("https://{host}"))?;
                if endpoint.scheme() == "http" && transport::loopback(&site) {
                    transport::endpoint(&format!("http://{host}"))
                } else {
                    Ok(site)
                }
            })
            .transpose()?;
        if matches!(self, Self::Model { model, .. } if model.trim().is_empty() || model.len() > 512 || model.chars().any(char::is_control))
        {
            return Err(ConnectionError::Invalid);
        }
        Ok((endpoint, site))
    }

    pub(super) fn same_destination(&self, other: &Self) -> bool {
        self.slot() == other.slot() && self.destination() == other.destination()
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SecretChange {
    Keep,
    Clear,
    Token { value: String },
    Oauth { client_id: String },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionUpdate {
    pub profile: Profile,
    pub secret: SecretChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Missing,
    Ready,
    Expired,
    Unsupported,
}

#[derive(Debug, Serialize)]
pub struct Connection {
    pub profile: Profile,
    pub state: ConnectionState,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Stored {
    pub(super) profile: Profile,
    pub(super) version: Uuid,
    pub(super) credential: Option<Uuid>,
    pub(super) client_id: Option<String>,
}

impl Stored {
    pub(super) fn key(&self, vault: &VaultId) -> Option<String> {
        let credential = self.credential?;
        let (endpoint, site) = self.profile.destination();
        let digest = Sha256::new()
            .chain_update(&vault.0)
            .chain_update([0])
            .chain_update(endpoint)
            .chain_update([0])
            .chain_update(site.unwrap_or(""))
            .chain_update(credential.as_bytes())
            .finalize();
        Some(format!("{digest:x}"))
    }
}

pub(super) type Profiles = BTreeMap<Slot, Stored>;

pub(super) fn file(root: &Path, vault: &VaultId) -> PathBuf {
    root.join("agent").join(&vault.0).join("connections.json")
}

pub(super) fn load(path: &Path) -> Result<Profiles> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Profiles::new()),
        Err(_) => return Err(ConnectionError::Storage),
    };
    let profiles: Profiles =
        serde_json::from_reader(file.take(128 * 1024)).map_err(|_| ConnectionError::Storage)?;
    for (slot, entry) in &profiles {
        if *slot != entry.profile.slot() {
            return Err(ConnectionError::Storage);
        }
        entry
            .profile
            .addresses()
            .map_err(|_| ConnectionError::Storage)?;
    }
    Ok(profiles)
}

pub(super) fn save(path: &Path, profiles: &Profiles) -> Result<()> {
    let dir = path.parent().ok_or(ConnectionError::Storage)?;
    fs::create_dir_all(dir).map_err(|_| ConnectionError::Storage)?;
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|_| ConnectionError::Storage)?;
    serde_json::to_writer(&mut file, profiles).map_err(|_| ConnectionError::Storage)?;
    file.as_file()
        .sync_all()
        .map_err(|_| ConnectionError::Storage)?;
    file.persist(path).map_err(|_| ConnectionError::Storage)?;
    Ok(())
}

pub(super) fn epoch() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| ConnectionError::Storage)
}

pub(super) fn bearer(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8192 && value.bytes().all(|byte| byte.is_ascii_graphic())
}
