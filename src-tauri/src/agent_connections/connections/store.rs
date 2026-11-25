use std::{
    collections::BTreeMap,
    fs::{self, File, Metadata, OpenOptions},
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::agent_connections::{
    Connection, ConnectionError, ConnectionState, ConnectionUpdate, Result, SecretChange, Slot,
    VaultId,
    oauth::Grant,
    settings::{self, Profiles, Stored},
};

const MAX_AUTH_BYTES: u64 = 1024 * 1024;

type Credentials = BTreeMap<String, Credential>;

pub(super) struct Store {
    root: PathBuf,
    auth: PathBuf,
    lock: Mutex<()>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) enum Credential {
    Token(String),
    Oauth(Grant),
}

impl Credential {
    pub(super) fn access(&self, url: &Url) -> Result<&str> {
        match self {
            Self::Token(token) if settings::bearer(token) => Ok(token),
            Self::Token(_) => Err(ConnectionError::Storage),
            Self::Oauth(grant) => grant.access(url),
        }
    }

    fn state(&self) -> Result<ConnectionState> {
        match self {
            Self::Oauth(grant) if grant.stale()? => Ok(ConnectionState::Expired),
            Self::Token(_) | Self::Oauth(_) => Ok(ConnectionState::Ready),
        }
    }
}

impl Store {
    pub(super) fn new(root: PathBuf, home: PathBuf) -> Self {
        Self {
            root,
            auth: home.join(".livenote").join("auth.json"),
            lock: Mutex::default(),
        }
    }

    pub(super) fn with_profiles<T>(
        &self,
        vault: &VaultId,
        operation: impl FnOnce(&Path, Profiles) -> Result<T>,
    ) -> Result<T> {
        let _lock = self.lock.lock().map_err(|_| ConnectionError::Storage)?;
        let path = settings::file(&self.root, vault);
        let profiles = settings::load(&path)?;
        operation(&path, profiles)
    }

    pub(super) fn put(
        &self,
        vault: &VaultId,
        slot: Slot,
        update: ConnectionUpdate,
    ) -> Result<Connection> {
        self.with_profiles(vault, |path, mut profiles| {
            let previous = profiles.get(&slot);
            let mut stored = Stored {
                profile: update.profile,
                version: Uuid::new_v4(),
                credential: None,
                client_id: None,
            };
            let credential = match update.secret {
                SecretChange::Keep => {
                    if let Some(old) =
                        previous.filter(|old| old.profile.same_destination(&stored.profile))
                    {
                        stored.credential = old.credential;
                        stored.client_id.clone_from(&old.client_id);
                    }
                    self.get(vault, &stored)?
                }
                SecretChange::Clear => None,
                SecretChange::Token { value } => {
                    if !settings::bearer(&value) {
                        return Err(ConnectionError::Invalid);
                    }
                    stored.credential = Some(Uuid::new_v4());
                    let token = Credential::Token(value);
                    self.set(vault, &stored, &token)?;
                    Some(token)
                }
                SecretChange::Oauth { client_id } => {
                    if slot == Slot::Model || client_id.len() > 512 || !settings::bearer(&client_id)
                    {
                        return Err(ConnectionError::Invalid);
                    }
                    stored.credential = Some(Uuid::new_v4());
                    stored.client_id = Some(client_id);
                    None
                }
            };
            if let Some(old) = previous.filter(|old| old.credential != stored.credential) {
                self.delete(vault, old)?;
            }
            let result = Connection {
                state: credential
                    .as_ref()
                    .map(Credential::state)
                    .transpose()?
                    .unwrap_or(ConnectionState::Missing),
                profile: stored.profile.clone(),
            };
            profiles.insert(slot, stored);
            settings::save(path, &profiles)?;
            Ok(result)
        })
    }

    pub(super) fn get(&self, vault: &VaultId, stored: &Stored) -> Result<Option<Credential>> {
        let Some(key) = stored.key(vault) else {
            return Ok(None);
        };
        let _lock = self.lock_auth()?;
        let mut credentials = load(&self.auth)?;
        Ok(credentials.remove(&key))
    }

    pub(super) fn set(
        &self,
        vault: &VaultId,
        stored: &Stored,
        credential: &Credential,
    ) -> Result<()> {
        let key = stored.key(vault).ok_or(ConnectionError::Storage)?;
        let _lock = self.lock_auth()?;
        let mut credentials = load(&self.auth)?;
        credentials.insert(key, credential.clone());
        save(&self.auth, &credentials)
    }

    fn delete(&self, vault: &VaultId, stored: &Stored) -> Result<()> {
        let Some(key) = stored.key(vault) else {
            return Ok(());
        };
        let _lock = self.lock_auth()?;
        let mut credentials = load(&self.auth)?;
        if credentials.remove(&key).is_some() {
            save(&self.auth, &credentials)?;
        }
        Ok(())
    }

    fn lock_auth(&self) -> Result<File> {
        let directory = self.auth.parent().ok_or(ConnectionError::Storage)?;
        ensure_directory(directory)?;
        let path = directory.join("auth.json.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(|_| ConnectionError::Storage)?;
        verify_opened(&path, &file)?;
        set_private(&file)?;
        file.lock().map_err(|_| ConnectionError::Storage)?;
        Ok(file)
    }
}

fn ensure_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(ConnectionError::Storage),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|_| ConnectionError::Storage)?;
            let metadata = fs::symlink_metadata(path).map_err(|_| ConnectionError::Storage)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                Ok(())
            } else {
                Err(ConnectionError::Storage)
            }
        }
        Err(_) => Err(ConnectionError::Storage),
    }
}

fn load(path: &Path) -> Result<Credentials> {
    let file = match fs::symlink_metadata(path) {
        Ok(_) => open_regular(path)?,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Credentials::new()),
        Err(_) => return Err(ConnectionError::Storage),
    };
    serde_json::from_reader(file.take(MAX_AUTH_BYTES)).map_err(|_| ConnectionError::Storage)
}

fn save(path: &Path, credentials: &Credentials) -> Result<()> {
    ensure_target(path)?;
    let directory = path.parent().ok_or(ConnectionError::Storage)?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|_| ConnectionError::Storage)?;
    set_private(file.as_file())?;
    serde_json::to_writer(&mut file, credentials).map_err(|_| ConnectionError::Storage)?;
    file.as_file()
        .sync_all()
        .map_err(|_| ConnectionError::Storage)?;
    ensure_target(path)?;
    file.persist(path).map_err(|_| ConnectionError::Storage)?;
    Ok(())
}

fn ensure_target(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(ConnectionError::Storage),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ConnectionError::Storage),
    }
}

fn open_regular(path: &Path) -> Result<File> {
    let file = File::open(path).map_err(|_| ConnectionError::Storage)?;
    verify_opened(path, &file)?;
    Ok(file)
}

fn verify_opened(path: &Path, file: &File) -> Result<()> {
    let expected = fs::symlink_metadata(path).map_err(|_| ConnectionError::Storage)?;
    let actual = file.metadata().map_err(|_| ConnectionError::Storage)?;
    if expected.is_file()
        && !expected.file_type().is_symlink()
        && actual.is_file()
        && same_file(&expected, &actual)
    {
        Ok(())
    } else {
        Err(ConnectionError::Storage)
    }
}

#[cfg(unix)]
fn same_file(expected: &Metadata, actual: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    expected.dev() == actual.dev() && expected.ino() == actual.ino()
}

#[cfg(not(unix))]
fn same_file(expected: &Metadata, actual: &Metadata) -> bool {
    expected.file_type() == actual.file_type() && expected.len() == actual.len()
}

#[cfg(unix)]
fn set_private(file: &File) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| ConnectionError::Storage)
}

#[cfg(not(unix))]
fn set_private(_file: &File) -> Result<()> {
    Ok(())
}
