use bytes::Bytes;
use reqwest::Client;
use rig::{
    completion::CompletionError,
    http_client::{
        self, HttpClientExt, LazyBody, MultipartForm, Request, Response, StreamingResponse,
    },
    prelude::CompletionClient,
    providers::openai::{CompletionsClient, completion},
};
use serde::Deserialize;
use url::Url;

use super::{ConnectionError, ModelError, Result, model_http};

const MAX_ARGUMENTS: usize = 80 * 1024;
pub type ModelClient = completion::CompletionModel<ModelTransport>;

pub(super) fn connect(
    http: Client,
    mut base: Url,
    model: String,
    token: String,
) -> Result<ModelClient> {
    let path = format!("{}/chat/completions", base.path().trim_end_matches('/'));
    let base_url = base.as_str().trim_end_matches('/').to_owned();
    base.set_path(&path);
    let client = CompletionsClient::<ModelTransport>::builder()
        .base_url(base_url)
        .api_key(token)
        .http_client(ModelTransport(Some((http, base))))
        .build()
        .map_err(|_| ConnectionError::Invalid)?;
    Ok(client.completion_model(model))
}

pub(crate) fn completion_error(error: CompletionError) -> ModelError {
    match error {
        CompletionError::HttpError(http_client::Error::Instance(error)) => error
            .downcast::<ModelError>()
            .map_or(ModelError::Request, |error| *error),
        CompletionError::JsonError(_)
        | CompletionError::ResponseError(_)
        | CompletionError::ProviderError(_) => ModelError::InvalidResponse,
        CompletionError::HttpError(_)
        | CompletionError::UrlError(_)
        | CompletionError::RequestError(_) => ModelError::Request,
    }
}

#[derive(Clone, Debug, Default)]
pub struct ModelTransport(Option<(Client, Url)>);

fn failure(error: ModelError) -> http_client::Error {
    http_client::Error::Instance(Box::new(error))
}

impl HttpClientExt for ModelTransport {
    fn send<T, U>(
        &self,
        request: Request<T>,
    ) -> impl Future<Output = http_client::Result<Response<LazyBody<U>>>> + Send + 'static
    where
        T: Into<Bytes> + Send,
        U: From<Bytes> + Send + 'static,
    {
        let (mut parts, body) = request.into_parts();
        if let Some(authorization) = parts.headers.get_mut(reqwest::header::AUTHORIZATION) {
            authorization.set_sensitive(true);
        }
        let body = body.into();
        let target = self.0.clone();
        async move {
            let (client, endpoint) = target.ok_or_else(|| failure(ModelError::Request))?;
            if parts.method != reqwest::Method::POST || parts.uri.to_string() != endpoint.as_str() {
                return Err(failure(ModelError::Request));
            }
            let request = client
                .post(endpoint)
                .headers(parts.headers)
                .body(body)
                .build()
                .map_err(|_| failure(ModelError::Request))?;
            let (status, bytes) = model_http::send(&client, request).await.map_err(failure)?;
            validate_envelope(&bytes).map_err(failure)?;
            let body: LazyBody<U> = Box::pin(async move { Ok(U::from(Bytes::from(bytes))) });
            Ok(Response::builder().status(status).body(body)?)
        }
    }

    fn send_multipart<U>(
        &self,
        _: Request<MultipartForm>,
    ) -> impl Future<Output = http_client::Result<Response<LazyBody<U>>>> + Send + 'static
    where
        U: From<Bytes> + Send + 'static,
    {
        std::future::ready(Err(failure(ModelError::Request)))
    }

    fn send_streaming<T>(
        &self,
        _: Request<T>,
    ) -> impl Future<Output = http_client::Result<StreamingResponse>> + Send
    where
        T: Into<Bytes>,
    {
        std::future::ready(Err(failure(ModelError::Request)))
    }
}

#[derive(Deserialize)]
struct LimitsEnvelope<'a> {
    usage: Option<completion::Usage>,
    #[serde(default, borrow)]
    choices: Vec<ChoiceLimits<'a>>,
}

#[derive(Deserialize)]
struct ChoiceLimits<'a> {
    #[serde(borrow)]
    message: MessageLimits<'a>,
}

#[derive(Deserialize)]
struct MessageLimits<'a> {
    #[serde(borrow)]
    tool_calls: Option<Vec<CallLimits<'a>>>,
}

#[derive(Deserialize)]
struct CallLimits<'a> {
    #[serde(borrow)]
    function: FunctionLimits<'a>,
}

#[derive(Deserialize)]
struct FunctionLimits<'a> {
    #[serde(borrow)]
    arguments: std::borrow::Cow<'a, str>,
}

fn validate_envelope(bytes: &[u8]) -> std::result::Result<(), ModelError> {
    let envelope: LimitsEnvelope<'_> =
        serde_json::from_slice(bytes).map_err(|_| ModelError::InvalidResponse)?;
    // Rig 0.31 вычисляет разность и сумму счётчиков без проверки.
    if envelope.usage.is_some_and(|usage| {
        usage.total_tokens < usage.prompt_tokens
            || u32::try_from(usage.total_tokens).is_err()
            || usage
                .prompt_tokens_details
                .is_some_and(|details| details.cached_tokens > usage.prompt_tokens)
    }) || envelope.choices.iter().any(|choice| {
        choice
            .message
            .tool_calls
            .iter()
            .flatten()
            .any(|call| call.function.arguments.len() > MAX_ARGUMENTS)
    }) {
        return Err(ModelError::InvalidResponse);
    }
    Ok(())
}
