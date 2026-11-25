//! Исходящие подключения агента и локальные настройки.

mod connections;
mod mcp_read;
mod mcp_wire;
mod model;
mod model_http;
mod oauth;
mod repo;
mod settings;
#[cfg(test)]
mod tests;
mod transport;

pub use connections::Connections;
pub use mcp_read::{Cite, Fragment, Hit, Lines, Query, ReadMcp, SearchScope, SourceRef};
pub use model::ModelClient;
pub(crate) use model::completion_error;
pub(crate) use model_http::ModelError;
pub use oauth::{OAUTH_CALLBACK_PATH, OAuthCallback};
pub use repo::{Provider, Repo, RepoProvider};
pub use settings::{
    Connection, ConnectionState, ConnectionUpdate, Profile, SecretChange, Slot, VaultId,
};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConnectionError {
    #[error("Параметры подключения неверны")]
    Invalid,
    #[error("Подключение не настроено")]
    Missing,
    #[error("Сервер отклонил учётные данные")]
    Expired,
    #[error("Сервер не поддерживает нужный протокол или формат ответа")]
    Unsupported,
    #[error("Внешний сервер не ответил или вернул ошибку")]
    Upstream,
    #[error("Не удалось открыть или сохранить локальные настройки")]
    Storage,
    #[error("Запрос входа истёк, уже использован или не соответствует настройкам")]
    OAuthState,
    #[error("Источник не входит в область поиска")]
    Scope,
}

pub type Result<T> = std::result::Result<T, ConnectionError>;
