use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use livenote_vault_service::{ApiError, agent_documents as d};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{agent_bindings as b, agent_connections as c};

use super::{context::TokenLimit, progress::Progress};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct SessionId(pub Uuid);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct TurnId(pub Uuid);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    id: TurnId,
    text: String,
    search: Search,
    focus: d::CapturedFocus,
    context_limit_tokens: Option<usize>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Search {
    DocsFirst,
    CodeFirst,
}

pub(crate) struct Submit {
    pub id: TurnId,
    pub text: String,
    pub search: Search,
    pub focus: d::CapturedFocus,
    pub digest: String,
    pub(super) context_limit: TokenLimit,
}

impl TryFrom<Value> for Submit {
    type Error = Error;

    fn try_from(value: Value) -> Result<Self> {
        let bytes =
            serde_json::to_vec(&value).map_err(|_| Error::invalid("Некорректное сообщение"))?;
        let input: Input = serde_json::from_value(value)
            .map_err(|_| Error::invalid("Некорректное сообщение или фокус редактора"))?;
        if input.text.trim().is_empty() || input.text.len() > 16 * 1024 {
            return Err(Error::invalid("Введите сообщение длиной до 16 КиБ"));
        }
        let context_limit = input
            .context_limit_tokens
            .map(TokenLimit::parse)
            .transpose()?;
        Ok(Self {
            id: input.id,
            text: input.text,
            search: input.search,
            focus: input.focus,
            digest: format!("{:x}", Sha256::digest(bytes)),
            context_limit: context_limit.unwrap_or_default(),
        })
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Cite {
    Vault {
        path: String,
        line: usize,
    },
    LocalCode {
        path: String,
        line: usize,
    },
    RemoteCode {
        url: String,
        path: String,
        line: usize,
    },
    Confluence {
        url: String,
        title: String,
    },
}

impl From<d::Cite> for Cite {
    fn from(cite: d::Cite) -> Self {
        Self::Vault {
            path: cite.path,
            line: cite.line,
        }
    }
}

impl From<b::Cite> for Cite {
    fn from(cite: b::Cite) -> Self {
        match cite {
            b::Cite::LocalCode { path, line } => Self::LocalCode { path, line },
        }
    }
}

impl From<c::Cite> for Cite {
    fn from(cite: c::Cite) -> Self {
        match cite {
            c::Cite::RemoteCode { url, path, line } => Self::RemoteCode { url, path, line },
            c::Cite::Confluence { url, title } => Self::Confluence { url, title },
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    pub id: SessionId,
    pub title: String,
    pub updated_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Turn {
    pub id: TurnId,
    pub text: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    #[serde(flatten)]
    pub state: TurnState,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum TurnState {
    Running,
    Done {
        answer: String,
        cites: Vec<Cite>,
        changed: Vec<String>,
    },
    Failed {
        error: Fault,
    },
    Interrupted {
        error: Fault,
    },
}

#[derive(Serialize)]
pub(crate) struct Conversation {
    pub session: Summary,
    pub turns: Vec<Turn>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Fault {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Paths>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Paths {
    pub paths: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct Error {
    pub status: StatusCode,
    pub fault: Fault,
}

pub(crate) type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            fault: Fault {
                code: code.into(),
                message: message.into(),
                details: None,
            },
        }
    }

    pub fn invalid(message: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }

    pub fn missing() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Объект агента не найден",
        )
    }

    pub fn busy() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "busy",
            "Агент уже работает в этом хранилище",
        )
    }

    pub fn storage() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage",
            "История агента недоступна",
        )
    }

    pub fn closing() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "interrupted",
            "LiveNote завершает работу",
        )
    }

    pub fn model_reply() -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "invalid_model_tool_call",
            "Модель вернула недопустимый вызов инструмента. Повторите запрос.",
        )
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.fault }))).into_response()
    }
}

impl From<ApiError> for Error {
    fn from(error: ApiError) -> Self {
        let status =
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let message = if status.is_server_error() {
            "Не удалось выполнить операцию с хранилищем".into()
        } else {
            error.message
        };
        let mut result = Self::new(status, error.code, message);
        result.fault.details = error
            .data
            .and_then(|data| serde_json::from_value(data).ok());
        result
    }
}

impl From<c::ConnectionError> for Error {
    fn from(error: c::ConnectionError) -> Self {
        use c::ConnectionError::*;
        let (status, code) = match error {
            Invalid => (StatusCode::BAD_REQUEST, "invalid_request"),
            Missing => (StatusCode::NOT_FOUND, "connection_missing"),
            Expired => (StatusCode::UNAUTHORIZED, "connection_expired"),
            Unsupported => (StatusCode::BAD_REQUEST, "connection_unsupported"),
            Upstream => (StatusCode::BAD_GATEWAY, "upstream"),
            Storage => (StatusCode::INTERNAL_SERVER_ERROR, "connection_storage"),
            OAuthState => (StatusCode::BAD_REQUEST, "oauth_state"),
            Scope => (StatusCode::FORBIDDEN, "source_scope"),
        };
        Self::new(status, code, error.to_string())
    }
}

impl From<b::BindingError> for Error {
    fn from(error: b::BindingError) -> Self {
        let status = match error.code {
            "conflict" => StatusCode::CONFLICT,
            "not_found" => StatusCode::NOT_FOUND,
            "storage" => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::BAD_REQUEST,
        };
        Self::new(status, error.code, error.message)
    }
}
