#[path = "../agent/http.rs"]
mod agent;
#[cfg(test)]
#[path = "../agent/tests.rs"]
mod agent_tests;
mod assets;
#[cfg(test)]
mod chat_browser_host;
mod events;
mod mcp;
mod rest;
mod security;

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, Uri},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use livenote_vault_service::{ApiError, Service};
use serde_json::{Value, json};
use tauri::AppHandle;
use tokio::sync::{Semaphore, oneshot};
use tokio_util::sync::CancellationToken;

const JSON_LIMIT: usize = 10 * 1024 * 1024;
const VERSION: &str = env!("CARGO_PKG_VERSION");
use crate::agent::AgentRuntime;

#[derive(Clone)]
pub(super) struct HttpState {
    pub(super) service: Arc<Service>,
    pub(super) shutdown: CancellationToken,
    app: Option<AppHandle>,
    access: security::Access,
    theme: Arc<str>,
    picker: Arc<Semaphore>,
    agent: AgentRuntime,
}

impl HttpState {
    pub(super) fn new(
        service: Service,
        app: AppHandle,
        shutdown: CancellationToken,
        port: u16,
        token: Option<String>,
        theme: String,
        agent: AgentRuntime,
    ) -> Self {
        Self {
            service: Arc::new(service),
            shutdown,
            app: Some(app),
            access: security::Access::new(port, token),
            theme: theme.into(),
            picker: Arc::new(Semaphore::new(1)),
            agent,
        }
    }
}

pub(super) fn router(state: HttpState, web_root: &std::path::Path) -> Router {
    let router = Router::new()
        .route("/api/config", get(config))
        .route("/api/vaults/open", post(open_vault))
        .route(
            "/api/vaults/{vault_id}/agent/binding/pick",
            post(agent::pick),
        )
        .route("/events", get(events::connect).head(events::head))
        .route(
            "/mcp",
            post(mcp::post)
                .get(mcp::method_not_allowed)
                .delete(mcp::method_not_allowed),
        )
        .nest("/api", rest::routes())
        .nest("/api/vaults/{vault_id}", rest::routes())
        .merge(agent::routes(state.service.clone(), state.agent.clone()));
    let router = assets::routes(router, web_root);
    router
        .layer(DefaultBodyLimit::max(JSON_LIMIT))
        .layer(middleware::from_fn_with_state(
            state.access.clone(),
            security::check,
        ))
        .with_state(state)
}

async fn config(State(state): State<HttpState>) -> Json<Value> {
    Json(json!({
        "version": VERSION,
        "tokenRequired": state.access.token_required(),
        "mermaidTheme": state.theme.as_ref(),
        "storage": "vault",
        "folderPickerAvailable": state.app.is_some() && !state.shutdown.is_cancelled(),
        "agentChat": !state.shutdown.is_cancelled(),
        "defaultVaultId": state.service.startup_id(),
    }))
}

async fn open_vault(
    State(state): State<HttpState>,
    uri: Uri,
    headers: HeaderMap,
    parsed: Result<Json<Value>, JsonRejection>,
) -> Response {
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default();
    if !content_type.trim().eq_ignore_ascii_case("application/json") {
        return security::reject(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Требуется Content-Type: application/json",
        );
    }
    if uri.query().is_some_and(|query| !query.is_empty()) {
        return bad_request("Параметры запроса не поддерживаются");
    }
    if !parsed.is_ok_and(|Json(value)| value.as_object().is_some_and(|object| object.is_empty())) {
        return bad_request("Требуется пустой JSON-объект");
    }
    let path = match pick_folder(&state, "Выберите папку для LiveNote").await {
        Ok(Some(path)) => path,
        Ok(None) => return Json(json!({ "vault": null })).into_response(),
        Err(response) => return response,
    };
    match state.service.open_selected(path).await {
        Ok(vault) => Json(json!({ "vault": vault })).into_response(),
        Err(error) => api_error(error),
    }
}

async fn pick_folder(
    state: &HttpState,
    title: &str,
) -> Result<Option<std::path::PathBuf>, Response> {
    use tauri_plugin_dialog::DialogExt;
    if state.shutdown.is_cancelled() {
        return Err(closing());
    }
    let Some(app) = &state.app else {
        return Err(security::reject(
            StatusCode::SERVICE_UNAVAILABLE,
            "folder_picker_unavailable",
            "Системный диалог недоступен",
        ));
    };
    let Ok(permit) = state.picker.clone().try_acquire_owned() else {
        return Err(security::reject(
            StatusCode::CONFLICT,
            "folder_picker_busy",
            "Диалог выбора каталога уже открыт",
        ));
    };
    let (selected, wait) = oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .pick_folder(move |folder| {
            drop(permit);
            drop(selected.send(folder));
        });
    let folder = tokio::select! {
        biased;
        () = state.shutdown.cancelled() => return Err(closing()),
        selection = wait => match selection {
            Ok(selection) => selection,
            Err(_) => {
                return Err(security::reject(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "folder_picker_unavailable",
                    "Системный диалог недоступен",
                ));
            }
        },
    };
    folder
        .map(|folder| {
            folder
                .into_path()
                .map_err(|_| bad_request("Системный диалог не вернул путь к папке"))
        })
        .transpose()
}

pub(super) fn bad_request(message: impl Into<String>) -> Response {
    security::reject(StatusCode::BAD_REQUEST, "invalid_request", message)
}

fn closing() -> Response {
    security::reject(
        StatusCode::SERVICE_UNAVAILABLE,
        "server_closing",
        "LiveNote завершает работу",
    )
}

fn api_error(error: ApiError) -> Response {
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut body = json!({ "code": error.code, "message": error.message });
    if let Some(details) = error.data {
        body["details"] = details;
    }
    (status, Json(json!({ "error": body }))).into_response()
}
