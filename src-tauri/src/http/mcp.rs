use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use livenote_mcp::{Config, StorageMode, ToolCall, ToolError};
use livenote_vault_service::{Output, Scope, Service};
use serde_json::{Value, json};

use super::{HttpState, VERSION, closing, security::reject};

pub(super) async fn post(
    State(state): State<HttpState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if state.shutdown.is_cancelled() {
        return closing();
    }
    let accept = header_text(&headers, header::ACCEPT);
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return rpc_error(
            StatusCode::NOT_ACCEPTABLE,
            -32000,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
        );
    }
    let content_type = header_text(&headers, header::CONTENT_TYPE);
    if !content_type
        .split(';')
        .next()
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
    {
        return rpc_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
        );
    }
    let Ok(body) = serde_json::from_slice(&body) else {
        return rpc_error(StatusCode::BAD_REQUEST, -32700, "Parse error: Invalid JSON");
    };
    let protocol_version = headers
        .get("mcp-protocol-version")
        .and_then(|value| value.to_str().ok());
    let config = Config {
        server_version: VERSION,
        storage: StorageMode::Vaults,
        protocol_version,
    };
    match livenote_mcp::handle(body, config, |call| run(&state.service, call)).await {
        livenote_mcp::Response::Accepted => StatusCode::ACCEPTED.into_response(),
        livenote_mcp::Response::Json { status, body } => {
            let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (status, Json(body)).into_response()
        }
    }
}

async fn run(service: &Service, call: ToolCall) -> Result<Value, ToolError> {
    let operation = serde_json::to_value(call.tool).map_err(|error| {
        ToolError::Other(format!("Не удалось определить инструмент MCP: {error}"))
    })?;
    let name = operation
        .as_str()
        .ok_or_else(|| ToolError::Other(String::from("Неизвестный инструмент MCP")))?;
    let mut arguments = call.arguments;
    if let Some(vault_id) = call.vault_id {
        arguments.insert("vault_id".into(), Value::String(vault_id.as_str().into()));
    }
    match service
        .call(name, Value::Object(arguments), Scope::Mcp)
        .await
    {
        Ok(Output::Json(value)) => Ok(value),
        Ok(Output::Empty) => Ok(Value::Null),
        Ok(Output::Bytes(_)) => Err(ToolError::Other(String::from(
            "Инструмент MCP вернул двоичные данные вместо JSON",
        ))),
        Err(error) => Err(ToolError::Application {
            code: error.code.into(),
            message: error.message,
            details: error.data,
        }),
    }
}

pub(super) async fn method_not_allowed() -> Response {
    let mut response = reject(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        "Поддерживается только POST /mcp",
    );
    response
        .headers_mut()
        .insert(header::ALLOW, HeaderValue::from_static("POST"));
    response
}

fn rpc_error(status: StatusCode, code: i32, message: &str) -> Response {
    let body = json!({
        "jsonrpc": "2.0",
        "id": null,
        "error": { "code": code, "message": message }
    });
    (status, Json(body)).into_response()
}

fn header_text(headers: &HeaderMap, name: header::HeaderName) -> &str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
}
