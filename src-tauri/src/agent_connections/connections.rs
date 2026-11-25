mod login;
mod store;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use reqwest::Client;
use url::Url;
use uuid::Uuid;

use super::{
    Connection, ConnectionError, ConnectionState, ConnectionUpdate, ModelClient, Profile, Provider,
    ReadMcp, Result, Slot, VaultId, mcp_read,
    mcp_wire::Session,
    oauth::{OAUTH_CALLBACK_PATH, Pending},
    settings::Stored,
    transport,
};
use store::{Credential, Store};

#[derive(Clone)]
pub struct Connections(Arc<Shared>);

struct Shared {
    http: Client,
    model_http: Client,
    redirect: Url,
    store: Store,
    pending: Mutex<HashMap<String, Pending>>,
    observed: Mutex<HashMap<(VaultId, Slot), (Uuid, ConnectionState)>>,
    refresh: tokio::sync::Mutex<()>,
}

impl Connections {
    /// `data_dir` — каталог `app_local_data_dir`, `home` — домашний каталог пользователя.
    /// `port` — порт loopback-сервера.
    pub fn new(data_dir: PathBuf, home: PathBuf, port: u16) -> Result<Self> {
        Self::with_store(Store::new(data_dir, home), port)
    }

    fn with_store(store: Store, port: u16) -> Result<Self> {
        if port == 0 {
            return Err(ConnectionError::Invalid);
        }
        let redirect =
            transport::endpoint(&format!("http://127.0.0.1:{port}{OAUTH_CALLBACK_PATH}"))?;
        Ok(Self(Arc::new(Shared {
            http: transport::client()?,
            model_http: super::model_http::client()?,
            redirect,
            store,
            pending: Mutex::default(),
            observed: Mutex::default(),
            refresh: tokio::sync::Mutex::new(()),
        })))
    }

    #[cfg(test)]
    pub(crate) fn fixture(data_dir: PathBuf, port: u16) -> Result<Self> {
        Self::with_store(Store::new(data_dir.clone(), data_dir), port)
    }

    pub async fn list(&self, vault: &VaultId) -> Result<Vec<Connection>> {
        let shared = Arc::clone(&self.0);
        let vault = vault.clone();
        blocking(move || {
            shared.store.with_profiles(&vault, |_, profiles| {
                profiles
                    .into_iter()
                    .map(|(slot, stored)| {
                        let credential = shared.store.get(&vault, &stored)?;
                        let observed = shared
                            .observed
                            .lock()
                            .map_err(|_| ConnectionError::Storage)?
                            .get(&(vault.clone(), slot))
                            .filter(|(version, _)| *version == stored.version)
                            .map(|(_, state)| *state);
                        let state = match credential {
                            None => observed.unwrap_or(ConnectionState::Missing),
                            Some(Credential::Oauth(grant)) if grant.stale()? => {
                                ConnectionState::Expired
                            }
                            Some(Credential::Token(_)) | Some(Credential::Oauth(_)) => {
                                observed.unwrap_or(ConnectionState::Ready)
                            }
                        };
                        Ok(Connection {
                            profile: stored.profile,
                            state,
                        })
                    })
                    .collect()
            })
        })
        .await
    }

    pub async fn put(
        &self,
        vault: &VaultId,
        slot: Slot,
        update: ConnectionUpdate,
    ) -> Result<Connection> {
        if update.profile.slot() != slot {
            return Err(ConnectionError::Invalid);
        }
        update.profile.addresses()?;
        let shared = Arc::clone(&self.0);
        let vault = vault.clone();
        blocking(move || shared.store.put(&vault, slot, update)).await
    }

    pub async fn model(&self, vault: &VaultId) -> Result<ModelClient> {
        let (stored, credential) = self.snapshot(vault, Slot::Model).await?;
        let (url, _) = stored.profile.addresses()?;
        match (stored.profile, credential) {
            (Profile::Model { model, .. }, Some(Credential::Token(token))) => {
                super::model::connect(self.0.model_http.clone(), url, model, token)
            }
            _ => Err(ConnectionError::Missing),
        }
    }

    pub async fn mcp(&self, vault: &VaultId, provider: Provider) -> Result<ReadMcp> {
        let slot = Slot::from(provider);
        let (stored, mut credential) = self.snapshot(vault, slot).await?;
        let (endpoint, site) = stored.profile.addresses()?;
        let site = site.ok_or(ConnectionError::Scope)?;
        if let Some(Credential::Oauth(grant)) = &credential
            && grant.stale()?
        {
            credential = Some(self.refresh(vault, slot, &stored, grant, false).await?);
        }
        let credential = credential.ok_or(ConnectionError::Missing)?;
        let token = credential.access(&endpoint)?.to_owned();
        let mut session = self.open(provider, &endpoint, token).await;
        if matches!(session, Err(ConnectionError::Expired))
            && let Credential::Oauth(grant) = credential
        {
            let credential = self.refresh(vault, slot, &stored, &grant, true).await?;
            session = self
                .open(
                    provider,
                    &endpoint,
                    credential.access(&endpoint)?.to_owned(),
                )
                .await;
        }
        let status = match &session {
            Ok(_) => Some(ConnectionState::Ready),
            Err(ConnectionError::Unsupported) => Some(ConnectionState::Unsupported),
            Err(ConnectionError::Expired) => Some(ConnectionState::Expired),
            Err(_) => None,
        };
        if let Some(state) = status {
            self.observe(vault, slot, stored.version, state)?;
        }
        Ok(ReadMcp::new(session?, provider, site))
    }

    async fn open(&self, provider: Provider, endpoint: &Url, token: String) -> Result<Session> {
        Session::open(
            self.0.http.clone(),
            endpoint.clone(),
            token,
            mcp_read::allowed(provider),
            mcp_read::optional(provider),
        )
        .await
    }

    async fn snapshot(&self, vault: &VaultId, slot: Slot) -> Result<(Stored, Option<Credential>)> {
        let shared = Arc::clone(&self.0);
        let vault = vault.clone();
        blocking(move || {
            shared.store.with_profiles(&vault, |_, profiles| {
                let entry = profiles
                    .get(&slot)
                    .cloned()
                    .ok_or(ConnectionError::Missing)?;
                let credential = shared.store.get(&vault, &entry)?;
                Ok((entry, credential))
            })
        })
        .await
    }

    fn observe(
        &self,
        vault: &VaultId,
        slot: Slot,
        version: Uuid,
        state: ConnectionState,
    ) -> Result<()> {
        self.0
            .observed
            .lock()
            .map_err(|_| ConnectionError::Storage)?
            .insert((vault.clone(), slot), (version, state));
        Ok(())
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| ConnectionError::Storage)?
}
