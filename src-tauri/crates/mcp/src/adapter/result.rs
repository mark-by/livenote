use serde_json::{Value, json};

use super::Tool;

/// Ошибка, которую сервис возвращает для ответа `isError`.
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    /// Ошибка сервиса с кодом и необязательными данными.
    #[error("Ошибка [{code}]: {message}{}", details.as_ref().map_or_else(String::new, |value| format!(" Данные: {value}")))]
    Application {
        /// Код ошибки сервиса.
        code: String,
        /// Сообщение для клиента.
        message: String,
        /// Данные ошибки. `Some(Value::Null)` означает явный JSON `null`.
        details: Option<Value>,
    },
    /// Ошибка без кода сервиса.
    #[error("{0}")]
    Other(String),
}

pub(super) fn failure(text: &str) -> Value {
    json!({"content": [{"type": "text", "text": text}], "isError": true})
}

pub(super) fn encode(tool: Tool, output: Result<Value, ToolError>) -> Value {
    let mut payload = match output {
        Ok(payload) => payload,
        Err(error) => return failure(&error.to_string()),
    };
    match tool {
        Tool::ListVaults => {
            let vaults = payload.get("vaults").and_then(Value::as_array);
            let selected = vaults.and_then(|vaults| vaults.iter().map(|vault| {
                Some(json!({"id": vault.get("id")?.as_str()?, "name": vault.get("name")?.as_str()?}))
            }).collect::<Option<Vec<_>>>());
            let Some(selected) = selected else {
                return failure(
                    "MCP error -32602: Output validation error: Invalid structured content for tool list_vaults",
                );
            };
            let structured = json!({"vaults": selected});
            json!({"content": [{"type": "text", "text": structured.to_string()}], "structuredContent": structured})
        }
        Tool::DeletePage => {
            json!({"content": [{"type": "text", "text": "Страница удалена окончательно"}]})
        }
        Tool::AddPage => {
            let Some(fields) = payload.as_object_mut() else {
                return failure("Invalid service result for add_page");
            };
            let mut page = serde_json::Map::new();
            for (source, target) in [
                ("id", "page_id"),
                ("title", "title"),
                ("revision", "revision"),
            ] {
                if let Some(value) = fields.swap_remove(source) {
                    page.insert(target.to_owned(), value);
                }
            }
            text(&Value::Object(page))
        }
        Tool::CheckDiagram => {
            if let Some(fields) = payload.as_object_mut() {
                fields.shift_remove("render");
            }
            text(&payload)
        }
        Tool::ListPages
        | Tool::GetPage
        | Tool::WriteMarkdown
        | Tool::WriteDiagram
        | Tool::LayoutDiagram
        | Tool::UpdatePage
        | Tool::GetVault
        | Tool::GetDocument
        | Tool::WriteDocument
        | Tool::CreateFolder
        | Tool::MoveFolder
        | Tool::DeleteFolder
        | Tool::MoveDocument => text(&payload),
    }
}

fn text(payload: &Value) -> Value {
    json!({"content": [{"type": "text", "text": payload.to_string()}]})
}
