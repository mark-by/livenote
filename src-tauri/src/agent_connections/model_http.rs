use std::time::{Duration, SystemTime};

use reqwest::{Client, Request, StatusCode, header};

use super::{ConnectionError, transport};

const BACKOFF: [Duration; 2] = [Duration::from_millis(100), Duration::from_millis(200)];
const MAX_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, thiserror::Error)]
pub(crate) enum ModelError {
    #[error("Сервис модели вернул ошибку (HTTP {}).", .0.as_u16())]
    Http(StatusCode),
    #[error("Сервис модели не ответил вовремя.")]
    Timeout,
    #[error("Не удалось подключиться к сервису модели.")]
    Connect,
    #[error("Ответ сервиса модели оборвался при передаче.")]
    InterruptedResponse,
    #[error("Не удалось отправить запрос к сервису модели.")]
    Request,
    #[error(
        "Сервис модели вернул ответ не в формате Chat Completions. Проверьте подключение модели."
    )]
    InvalidResponse,
    #[error("Ответ сервиса модели превышает допустимый размер.")]
    ResponseTooLarge,
}

pub(super) fn client() -> super::Result<Client> {
    transport::client_builder()
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| ConnectionError::Upstream)
}

pub(super) async fn send(
    client: &Client,
    request: Request,
) -> Result<(StatusCode, Vec<u8>), ModelError> {
    // Повторы остаются в том же future, чтобы остановка хода отменяла и ожидание.
    for backoff in BACKOFF {
        match attempt(client, &request).await {
            Ok(response) => return Ok(response),
            Err(AttemptError { reason, wait }) => {
                let Some(wait) = wait.filter(|wait| *wait <= MAX_WAIT) else {
                    return Err(reason);
                };
                tokio::time::sleep(backoff.max(wait)).await;
            }
        }
    }
    attempt(client, &request)
        .await
        .map_err(|error| error.reason)
}

struct AttemptError {
    reason: ModelError,
    wait: Option<Duration>,
}

impl From<ModelError> for AttemptError {
    fn from(reason: ModelError) -> Self {
        Self { reason, wait: None }
    }
}

async fn attempt(
    client: &Client,
    request: &Request,
) -> Result<(StatusCode, Vec<u8>), AttemptError> {
    let request = request.try_clone().ok_or(ModelError::Request)?;
    let mut response = client.execute(request).await.map_err(|error| {
        let reason = if error.is_timeout() {
            ModelError::Timeout
        } else if error.is_connect() {
            ModelError::Connect
        } else {
            return ModelError::Request.into();
        };
        AttemptError {
            reason,
            wait: Some(Duration::ZERO),
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        let wait = match status {
            StatusCode::REQUEST_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
            | StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT => retry_after(response.headers()),
            _ => None,
        };
        return Err(AttemptError {
            reason: ModelError::Http(status),
            wait,
        });
    }

    if response
        .content_length()
        .is_some_and(|len| usize::try_from(len).map_or(true, |len| len > transport::MAX_BODY))
    {
        return Err(ModelError::ResponseTooLarge.into());
    }
    let mut bytes = Vec::new();
    // Читаем HTTP-тело отдельно от разбора JSON. Ошибка чтения допускает повтор.
    while let Some(chunk) = response.chunk().await.map_err(|error| AttemptError {
        reason: if error.is_timeout() {
            ModelError::Timeout
        } else {
            ModelError::InterruptedResponse
        },
        wait: Some(Duration::ZERO),
    })? {
        transport::append(&mut bytes, &chunk).map_err(|_| ModelError::ResponseTooLarge)?;
    }
    Ok((status, bytes))
}

fn retry_after(headers: &header::HeaderMap) -> Option<Duration> {
    let values = headers.get_all(header::RETRY_AFTER);
    let mut values = values.iter();
    let Some(value) = values.next() else {
        return Some(Duration::ZERO);
    };
    if values.next().is_some() {
        return None;
    }
    let value = value.to_str().ok()?.trim();
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        return value.parse().ok().map(Duration::from_secs);
    }
    let date = httpdate::parse_http_date(value).ok()?;
    Some(date.duration_since(SystemTime::now()).unwrap_or_default())
}
