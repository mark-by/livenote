use std::{
    convert::Infallible,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::State,
    http::{HeaderValue, StatusCode, Uri},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
};
use serde_json::{Value, json};

use super::{HttpState, VERSION, api_error, bad_request, closing};

pub(super) async fn connect(State(state): State<HttpState>, uri: Uri) -> Response {
    if state.shutdown.is_cancelled() {
        return closing();
    }
    let query = uri.query().unwrap_or_default();
    let mut ids = url::form_urlencoded::parse(query.as_bytes())
        .filter_map(|(key, value)| (key == "vault_id").then_some(value));
    let id = ids.next();
    if ids.next().is_some() {
        return bad_request("Укажите один vault_id");
    }
    let mut subscription = match state.service.subscribe(id.as_deref()).await {
        Ok(subscription) => subscription,
        Err(error) => return api_error(error),
    };
    let shutdown = state.shutdown;
    let events = async_stream::stream! {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        let hello = json!({ "version": VERSION, "ts": stamp.as_millis() });
        yield Ok::<_, Infallible>(Event::default().event("hello").data(hello.to_string()));
        loop {
            let event = tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                event = subscription.recv() => event,
            };
            let Some(event) = event else { break };
            if let Some(name) = event.get("event").and_then(Value::as_str)
                && !name.contains(['\r', '\n'])
            {
                yield Ok(Event::default().event(name).data(event.to_string()));
            }
        }
    };
    let mut response = Sse::new(events)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(25))
                .text("ping"),
        )
        .into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    response
}

pub(super) async fn head() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [("allow", "GET")]).into_response()
}
