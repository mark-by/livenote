mod discovery;

use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

use super::{ConnectionError, Result, Slot, VaultId, settings, transport};

pub const OAUTH_CALLBACK_PATH: &str = "/api/agent/oauth/callback";
pub(super) const LIFETIME: Duration = Duration::from_secs(300);

pub struct OAuthCallback<'a> {
    pub host: &'a str,
    pub state: &'a str,
    pub code: &'a str,
}

pub(super) struct Pending {
    pub(super) vault: VaultId,
    pub(super) slot: Slot,
    pub(super) version: Uuid,
    pub(super) expires: Instant,
    context: GrantContext,
    verifier: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct GrantContext {
    resource: Url,
    issuer: Url,
    token_url: Url,
    client_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Grant {
    context: GrantContext,
    access: String,
    refresh: Option<String>,
    expires: Option<u64>,
}

impl Grant {
    pub(super) fn access(&self, resource: &Url) -> Result<&str> {
        if &self.context.resource != resource || !settings::bearer(&self.access) {
            return Err(ConnectionError::Storage);
        }
        Ok(&self.access)
    }

    pub(super) fn stale(&self) -> Result<bool> {
        let now = settings::epoch()?;
        Ok(self
            .expires
            .is_some_and(|expiration| expiration <= now.saturating_add(15)))
    }

    pub(super) async fn refresh(&self, http: &Client) -> Result<Self> {
        let refresh = self.refresh.as_deref().ok_or(ConnectionError::Expired)?;
        let refreshed = self
            .context
            .exchange(
                http,
                &[("grant_type", "refresh_token"), ("refresh_token", refresh)],
            )
            .await?;
        Ok(Self {
            refresh: refreshed.refresh.or_else(|| self.refresh.clone()),
            ..refreshed
        })
    }
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    token_type: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

impl GrantContext {
    async fn exchange(&self, http: &Client, fields: &[(&str, &str)]) -> Result<Grant> {
        let token_url = discovery::issuer_endpoint(&self.issuer, self.token_url.as_str())?;
        let mut form = fields.to_vec();
        form.extend([
            ("client_id", self.client_id.as_str()),
            ("resource", self.resource.as_str()),
        ]);
        let response = http
            .post(token_url)
            .header("Accept", "application/json")
            .form(&form)
            .send()
            .await
            .map_err(|_| ConnectionError::Upstream)?;
        if response.status() == StatusCode::BAD_REQUEST {
            #[derive(Deserialize)]
            struct OAuthError {
                error: String,
            }
            let bytes = transport::body(response).await?;
            return if serde_json::from_slice::<OAuthError>(&bytes)
                .is_ok_and(|reply| reply.error == "invalid_grant")
            {
                Err(ConnectionError::Expired)
            } else {
                Err(ConnectionError::Unsupported)
            };
        }
        let token: TokenReply = transport::json(response).await?;
        if !token.token_type.eq_ignore_ascii_case("bearer")
            || !settings::bearer(&token.access_token)
            || token
                .refresh_token
                .as_ref()
                .is_some_and(|token| !settings::bearer(token))
        {
            return Err(ConnectionError::Unsupported);
        }
        let now = settings::epoch()?;
        Ok(Grant {
            context: self.clone(),
            access: token.access_token,
            refresh: token.refresh_token,
            expires: token.expires_in.map(|seconds| now.saturating_add(seconds)),
        })
    }
}

impl Pending {
    pub(super) async fn begin(
        http: &Client,
        resource: Url,
        client_id: String,
        identity: (VaultId, Slot, Uuid),
        redirect: &Url,
    ) -> Result<(String, Self, Url)> {
        let metadata = discovery::discover(http, &resource).await?;
        let state = random_value();
        let verifier = random_value();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut authorization = metadata.authorization;
        let mut params = authorization.query_pairs_mut();
        params.extend_pairs([
            ("response_type", "code"),
            ("client_id", &client_id),
            ("redirect_uri", redirect.as_str()),
            ("state", &state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("resource", resource.as_str()),
        ]);
        if let Some(scope) = metadata.scope {
            params.append_pair("scope", &scope);
        }
        drop(params);
        let (vault, slot, version) = identity;
        let context = GrantContext {
            resource,
            issuer: metadata.issuer,
            token_url: metadata.token,
            client_id,
        };
        let pending = Self {
            vault,
            slot,
            version,
            expires: Instant::now() + LIFETIME,
            context,
            verifier,
        };
        Ok((state, pending, authorization))
    }

    pub(super) async fn exchange(
        &self,
        http: &Client,
        code: &str,
        redirect: &Url,
    ) -> Result<Grant> {
        if code.is_empty() || code.len() > 4096 || code.chars().any(char::is_control) {
            return Err(ConnectionError::OAuthState);
        }
        self.context
            .exchange(
                http,
                &[
                    ("grant_type", "authorization_code"),
                    ("redirect_uri", redirect.as_str()),
                    ("code", code),
                    ("code_verifier", &self.verifier),
                ],
            )
            .await
    }
}

fn random_value() -> String {
    let mut bytes = [0; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(super) fn check_callback_host(redirect: &Url, host: &str) -> Result<()> {
    let authority: reqwest::header::HeaderValue =
        host.parse().map_err(|_| ConnectionError::OAuthState)?;
    let expected = &redirect[url::Position::BeforeHost..url::Position::AfterPort];
    if !transport::loopback(redirect) || authority != expected {
        return Err(ConnectionError::OAuthState);
    }
    Ok(())
}
