use std::time::Duration;

use reqwest::{Client, ClientBuilder, Response, StatusCode, redirect::Policy};
use serde::de::DeserializeOwned;
use url::{Host, Url};

use super::{ConnectionError, Result};

pub(super) const MAX_BODY: usize = 2 * 1024 * 1024;

pub(super) fn client() -> Result<Client> {
    client_builder()
        .build()
        .map_err(|_| ConnectionError::Upstream)
}

pub(super) fn client_builder() -> ClientBuilder {
    Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(45))
        .pool_max_idle_per_host(4)
        .user_agent("LiveNote")
}

pub(super) fn loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(name)) => name == "localhost",
        None => false,
    }
}

pub(super) fn endpoint(text: &str) -> Result<Url> {
    let url = Url::parse(text).map_err(|_| ConnectionError::Invalid)?;
    if url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || url.scheme() == "http" && loopback(&url))
    {
        return Err(ConnectionError::Invalid);
    }
    Ok(url)
}

pub(super) fn check_status(status: StatusCode) -> Result<()> {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(ConnectionError::Expired),
        status if status.is_success() => Ok(()),
        _ => Err(ConnectionError::Upstream),
    }
}

pub(super) async fn body(mut response: Response) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ConnectionError::Upstream)?
    {
        append(&mut bytes, &chunk)?;
    }
    Ok(bytes)
}

pub(super) fn append(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<()> {
    if bytes.len().saturating_add(chunk.len()) > MAX_BODY {
        return Err(ConnectionError::Unsupported);
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

pub(super) async fn json<T: DeserializeOwned>(response: Response) -> Result<T> {
    check_status(response.status())?;
    serde_json::from_slice(&body(response).await?).map_err(|_| ConnectionError::Unsupported)
}
