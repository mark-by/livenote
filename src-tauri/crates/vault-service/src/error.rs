use serde_json::{Value, json};
use vault_files::VaultFileError;
use vault_read::VaultDocument;

/// Ошибка сценария с полями для REST и MCP.
#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub data: Option<Value>,
}

impl ApiError {
    pub(crate) fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            data: None,
        }
    }

    pub(crate) fn details(self, data: Value) -> Self {
        Self {
            data: Some(data),
            ..self
        }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, "invalid_request", message)
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "not_found", message)
    }

    pub(crate) fn internal(error: impl std::fmt::Display) -> Self {
        Self::new(500, "internal_error", error.to_string())
    }

    pub(crate) fn stale(paths: &[&str], current: Option<&VaultDocument>, tree: &str) -> Self {
        let details = json!({
            "paths": paths, "reason": "stale", "currentTreeVersion": tree,
            "currentRevision": current.map_or(0, |d| d.page.revision),
        });
        let details = match (current, details) {
            (Some(doc), Value::Object(mut fields)) => {
                fields.insert("currentVersion".into(), json!(doc.version));
                Value::Object(fields)
            }
            (_, details) => details,
        };
        Self::new(409, "conflict", "Файлы изменились; перечитайте документ").details(details)
    }

    pub(crate) fn missing(path: &str) -> Self {
        Self::new(409, "conflict", "Документ удалён")
            .details(json!({"currentRevision": 0, "reason": "missing", "paths": [path]}))
    }

    pub(crate) fn destination(path: &str, message: &str) -> Self {
        Self::new(409, "conflict", message)
            .details(json!({"currentRevision": 0, "reason": "destination_exists", "paths": [path]}))
    }

    pub(crate) fn block(page: &str, block: &str) -> Self {
        Self::not_found("Блок не найден в текущей ревизии")
            .details(json!({"pageId": page, "blockId": block}))
    }
}

impl From<VaultFileError> for ApiError {
    fn from(error: VaultFileError) -> Self {
        let status = match &error {
            VaultFileError::UnsafePath { .. } | VaultFileError::InvalidRequest { .. } => 400,
            VaultFileError::Locked
            | VaultFileError::Stale { .. }
            | VaultFileError::ChangedDuringRead { .. }
            | VaultFileError::TransactionIncomplete { .. } => 409,
            VaultFileError::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound => {
                404
            }
            _ => 500,
        };
        Self::new(status, error.code(), error.to_string())
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        Self::internal(error)
    }
}

impl From<vault_read::DocumentProblem> for ApiError {
    fn from(problem: vault_read::DocumentProblem) -> Self {
        Self::invalid(problem.message).details(json!({"code": problem.code, "path": problem.path}))
    }
}
