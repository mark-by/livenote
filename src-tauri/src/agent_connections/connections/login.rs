use std::{sync::Arc, time::Instant};

use url::Url;

use super::{Connections, Credential, blocking};
use crate::agent_connections::{
    ConnectionError, ConnectionState, OAuthCallback, Result, Slot, VaultId,
    oauth::{self, Grant, Pending},
    settings::Stored,
};

impl Connections {
    pub async fn begin_oauth(&self, vault: &VaultId, slot: Slot) -> Result<Url> {
        let (stored, _) = self.snapshot(vault, slot).await?;
        let client_id = stored.client_id.ok_or(ConnectionError::Unsupported)?;
        let (endpoint, _) = stored.profile.addresses()?;
        let identity = (vault.clone(), slot, stored.version);
        let result = Pending::begin(
            &self.0.http,
            endpoint,
            client_id,
            identity,
            &self.0.redirect,
        )
        .await;
        if matches!(result, Err(ConnectionError::Unsupported)) {
            self.observe(vault, slot, stored.version, ConnectionState::Unsupported)?;
        }
        let (state, pending, authorization) = result?;
        let now = Instant::now();
        let mut active = self
            .0
            .pending
            .lock()
            .map_err(|_| ConnectionError::Storage)?;
        active.retain(|_, value| {
            value.expires > now && (&value.vault != vault || value.slot != slot)
        });
        if active.len() >= 64 {
            return Err(ConnectionError::OAuthState);
        }
        active.insert(state, pending);
        Ok(authorization)
    }

    pub async fn finish_oauth(&self, callback: OAuthCallback<'_>) -> Result<()> {
        oauth::check_callback_host(&self.0.redirect, callback.host)?;
        let pending = self
            .0
            .pending
            .lock()
            .map_err(|_| ConnectionError::Storage)?
            .remove(callback.state)
            .ok_or(ConnectionError::OAuthState)?;
        if pending.expires <= Instant::now() {
            return Err(ConnectionError::OAuthState);
        }
        let (stored, _) = self
            .snapshot(&pending.vault, pending.slot)
            .await
            .map_err(|error| match error {
                ConnectionError::Missing => ConnectionError::OAuthState,
                other => other,
            })?;
        if stored.version != pending.version {
            return Err(ConnectionError::OAuthState);
        }
        let grant = pending
            .exchange(&self.0.http, callback.code, &self.0.redirect)
            .await?;
        self.save_grant(&pending.vault, pending.slot, stored, grant)
            .await?;
        self.observe(
            &pending.vault,
            pending.slot,
            pending.version,
            ConnectionState::Ready,
        )
    }

    pub(super) async fn refresh(
        &self,
        vault: &VaultId,
        slot: Slot,
        expected: &Stored,
        previous: &Grant,
        rejected: bool,
    ) -> Result<Credential> {
        let _lock = self.0.refresh.lock().await;
        let (stored, credential) = self.snapshot(vault, slot).await?;
        if stored.version != expected.version {
            return Err(ConnectionError::OAuthState);
        }
        let Some(Credential::Oauth(grant)) = credential else {
            return Err(ConnectionError::Expired);
        };
        let (endpoint, _) = stored.profile.addresses()?;
        if !grant.stale()?
            && (!rejected || grant.access(&endpoint)? != previous.access(&endpoint)?)
        {
            return Ok(Credential::Oauth(grant));
        }
        match grant.refresh(&self.0.http).await {
            Ok(grant) => self.save_grant(vault, slot, stored, grant).await,
            Err(ConnectionError::Expired) => {
                self.observe(vault, slot, stored.version, ConnectionState::Expired)?;
                Err(ConnectionError::Expired)
            }
            Err(error) => Err(error),
        }
    }

    async fn save_grant(
        &self,
        vault: &VaultId,
        slot: Slot,
        expected: Stored,
        grant: Grant,
    ) -> Result<Credential> {
        let shared = Arc::clone(&self.0);
        let vault = vault.clone();
        blocking(move || {
            shared.store.with_profiles(&vault, |_, profiles| {
                let entry = profiles
                    .get(&slot)
                    .filter(|entry| entry.version == expected.version)
                    .ok_or(ConnectionError::OAuthState)?;
                let credential = Credential::Oauth(grant);
                shared.store.set(&vault, entry, &credential)?;
                Ok(credential)
            })
        })
        .await
    }
}
