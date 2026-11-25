use reqwest::{Client, StatusCode};
use serde::Deserialize;
use url::Url;

use crate::agent_connections::{ConnectionError, Result, transport};

#[derive(Deserialize)]
struct ProtectedResource {
    resource: String,
    authorization_servers: Vec<String>,
}

#[derive(Deserialize)]
struct AuthorizationServer {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    code_challenge_methods_supported: Vec<String>,
    response_types_supported: Vec<String>,
    token_endpoint_auth_methods_supported: Option<Vec<String>>,
    grant_types_supported: Option<Vec<String>>,
}

pub(super) struct Verified {
    pub(super) issuer: Url,
    pub(super) authorization: Url,
    pub(super) token: Url,
    pub(super) scope: Option<String>,
}

pub(super) async fn discover(http: &Client, resource: &Url) -> Result<Verified> {
    let response = http.post(resource.clone()).header("Accept", "application/json, text/event-stream")
        .json(&serde_json::json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{
            "protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"LiveNote","version":env!("CARGO_PKG_VERSION")}
        }}))
        .send().await.map_err(|_| ConnectionError::Upstream)?;
    if response.status().is_redirection() {
        return Err(ConnectionError::Unsupported);
    }
    let challenge = response
        .headers()
        .get(reqwest::header::WWW_AUTHENTICATE)
        .and_then(|value| value.to_str().ok())
        .and_then(bearer_challenge);
    let metadata = match challenge.and_then(|value| param(value, "resource_metadata")) {
        Some(address) => {
            let address = checked(address)?;
            if address.origin() != resource.origin() {
                return Err(ConnectionError::Unsupported);
            }
            get::<ProtectedResource>(http, address)
                .await?
                .ok_or(ConnectionError::Unsupported)?
        }
        None => {
            get_metadata::<ProtectedResource>(http, resource, &["oauth-protected-resource"], true)
                .await?
        }
    };
    if checked(&metadata.resource)? != *resource {
        return Err(ConnectionError::Unsupported);
    }
    let [issuer] = metadata.authorization_servers.as_slice() else {
        return Err(ConnectionError::Unsupported);
    };
    let issuer = checked(issuer)?;
    if transport::loopback(&issuer) && issuer.origin() != resource.origin() {
        return Err(ConnectionError::Unsupported);
    }
    let server = get_metadata::<AuthorizationServer>(
        http,
        &issuer,
        &["oauth-authorization-server", "openid-configuration"],
        false,
    )
    .await?;
    if checked(&server.issuer)? != issuer
        || !contains(&server.code_challenge_methods_supported, "S256")
        || !contains(&server.response_types_supported, "code")
        || server
            .token_endpoint_auth_methods_supported
            .as_ref()
            .is_some_and(|methods| !contains(methods, "none"))
        || server
            .grant_types_supported
            .as_ref()
            .is_some_and(|grants| !contains(grants, "authorization_code"))
    {
        return Err(ConnectionError::Unsupported);
    }
    let authorization = issuer_endpoint(&issuer, &server.authorization_endpoint)?;
    let token = issuer_endpoint(&issuer, &server.token_endpoint)?;
    let scope = challenge
        .and_then(|value| param(value, "scope"))
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 512
                && value.bytes().all(|b| b == b' ' || b.is_ascii_graphic())
        })
        .map(str::to_owned);
    Ok(Verified {
        issuer,
        token,
        authorization,
        scope,
    })
}

fn bearer_challenge(header: &str) -> Option<&str> {
    let (scheme, params) = header.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then_some(params)
}

fn param<'a>(mut params: &'a str, key: &str) -> Option<&'a str> {
    while let Some((name, value)) = params.trim_start_matches([',', ' ', '\t']).split_once('=') {
        let value = value.trim_start();
        let (value, rest) = if let Some(quoted) = value.strip_prefix('"') {
            quoted.split_once('"')?
        } else {
            value.split_once(',').unwrap_or((value, ""))
        };
        if value.contains('\\') {
            return None;
        }
        if name.trim().eq_ignore_ascii_case(key) {
            return Some(value.trim());
        }
        params = rest;
    }
    None
}

pub(super) fn issuer_endpoint(issuer: &Url, address: &str) -> Result<Url> {
    let url = checked(address)?;
    if url.origin() != issuer.origin() {
        return Err(ConnectionError::Unsupported);
    }
    Ok(url)
}

fn checked(text: &str) -> Result<Url> {
    transport::endpoint(text).map_err(|_| ConnectionError::Unsupported)
}

fn contains(values: &[String], value: &str) -> bool {
    values.iter().any(|item| item == value)
}

async fn get_metadata<T: serde::de::DeserializeOwned>(
    http: &Client,
    origin: &Url,
    names: &[&str],
    resource: bool,
) -> Result<T> {
    let suffix = origin.path().trim_end_matches('/');
    for name in names {
        let mut url = origin.clone();
        url.set_path(&format!("/.well-known/{name}{suffix}"));
        if let Some(value) = get(http, url.clone()).await? {
            return Ok(value);
        }
        if !suffix.is_empty() {
            if resource {
                url.set_path(&format!("/.well-known/{name}"));
            } else if *name == "openid-configuration" {
                url.set_path(&format!("{suffix}/.well-known/{name}"));
            } else {
                continue;
            }
            if let Some(value) = get(http, url).await? {
                return Ok(value);
            }
        }
    }
    Err(ConnectionError::Unsupported)
}

async fn get<T: serde::de::DeserializeOwned>(http: &Client, url: Url) -> Result<Option<T>> {
    let response = http
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| ConnectionError::Upstream)?;
    if matches!(
        response.status(),
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
    ) {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(ConnectionError::Unsupported);
    }
    transport::json(response).await.map(Some)
}
