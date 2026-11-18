mod catalog;
mod message;
mod result;
mod schema;

use serde_json::{Value, json};

pub use catalog::{Tool, ToolCall, VaultId};
pub use result::ToolError;

const VERSIONS: [&str; 5] = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

/// Режим публикации инструментов.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageMode {
    /// Одно хранилище SQLite без поля `vault_id`.
    Sqlite,
    /// Реестр хранилищ с необязательным полем `vault_id`.
    Vaults,
}

/// Параметры одного POST.
#[derive(Clone, Copy, Debug)]
pub struct Config<'a> {
    /// Версия `LiveNote` для `initialize`.
    pub server_version: &'a str,
    /// Режим публикации инструментов.
    pub storage: StorageMode,
    /// Значение `MCP-Protocol-Version`, если клиент передал заголовок.
    pub protocol_version: Option<&'a str>,
}

/// Ответ, который HTTP-слой отправляет клиенту.
#[derive(Debug, PartialEq, Eq)]
pub enum Response {
    /// JSON с указанным HTTP-статусом.
    Json {
        /// HTTP-статус.
        status: u16,
        /// Тело ответа.
        body: Value,
    },
    /// HTTP 202 без тела.
    Accepted,
}

impl Response {
    fn rejected(code: i32, text: &str) -> Self {
        Self::Json {
            status: 400,
            body: message::error(&Value::Null, code, text),
        }
    }
}

/// Обрабатывает разобранное тело POST. Вызывающий код разбирает HTTP и проверяет доступ.
///
/// `call` получает проверенные аргументы. Он выбирает хранилище и вызывает сервис.
/// Для `add_page` верните объект страницы с `id`, `title` и `revision`, для
/// `list_vaults` — объект `{ "vaults": [...] }`. Результат `delete_page` не используется.
pub async fn handle<F, Fut>(body: Value, config: Config<'_>, call: F) -> Response
where
    F: Fn(ToolCall) -> Fut + Sync,
    Fut: Future<Output = Result<Value, ToolError>> + Send,
{
    let batch = match body {
        Value::Array(items) if items.len() > 100 => {
            return Response::rejected(
                -32600,
                "Invalid Request: Batch must not exceed 100 messages",
            );
        }
        Value::Array(items) => items,
        item => vec![item],
    };
    let Ok(messages) = batch
        .into_iter()
        .map(message::parse)
        .collect::<Result<Vec<_>, _>>()
    else {
        return Response::rejected(-32700, "Parse error: Invalid JSON-RPC message");
    };
    let initializes = messages.iter().flatten().any(message::Request::initializes);
    if initializes && messages.len() > 1 {
        return Response::rejected(
            -32600,
            "Invalid Request: Only one initialization request is allowed",
        );
    }
    if !initializes
        && let Some(version) = config.protocol_version
        && !VERSIONS.contains(&version)
    {
        let supported = VERSIONS.join(", ");
        let text = format!(
            "Bad Request: Unsupported protocol version: {version} (supported versions: {supported})"
        );
        return Response::rejected(-32000, &text);
    }
    let responses =
        futures_util::future::join_all(messages.into_iter().flatten().map(|request| async {
            let message::Request { id, method } = request;
            match method {
                message::Method::Initialize(version) => {
                    let version = VERSIONS
                        .iter()
                        .copied()
                        .find(|candidate| *candidate == version)
                        .unwrap_or("2025-11-25");
                    message::success(
                        id,
                        json!({
                            "protocolVersion": version,
                            "capabilities": {"tools": {"listChanged": true}},
                            "serverInfo": {"name": "livenote", "version": config.server_version}
                        }),
                    )
                }
                message::Method::Ping => message::success(id, json!({})),
                message::Method::List => match catalog::list(config.storage) {
                    Ok(tools) => message::success(id, json!({"tools": tools})),
                    Err(error) => message::error(&id, -32603, &error.to_string()),
                },
                message::Method::Call { name, arguments } => {
                    let value = match catalog::parse(config.storage, &name, arguments) {
                        Ok(operation) => {
                            let tool = operation.tool;
                            result::encode(tool, call(operation).await)
                        }
                        Err(error) => result::failure(&error.to_string()),
                    };
                    message::success(id, value)
                }
                message::Method::InvalidParams(text) => message::error(&id, -32603, &text),
                message::Method::Unknown => message::error(&id, -32601, "Method not found"),
            }
        }))
        .await;
    let body = match responses.len() {
        0 => return Response::Accepted,
        1 => responses.into_iter().next().unwrap_or_default(),
        _ => Value::Array(responses),
    };
    Response::Json { status: 200, body }
}
