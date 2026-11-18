//! Сценарии работы с хранилищем для HTTP и MCP.

mod archive;
mod args;
mod assets;
mod block;
mod block_edit;
mod diagram;
mod document;
mod edit;
mod error;
mod events;
mod folders;
mod links;
mod operations;
mod page;
mod receipt_signature;
mod registry;
mod service;
mod source;
mod state;
mod transaction;
mod tree;
mod writes;

use serde::Serialize;
use serde_json::Value;

pub use error::ApiError;
pub use events::Subscription;
pub use service::Service;

/// Правило выбора хранилища для вызова.
#[derive(Debug, Clone, Copy)]
pub enum Scope<'a> {
    Default,
    Vault(&'a str),
    Mcp,
}

/// Результат операции без транспортной обёртки.
#[derive(Debug)]
pub enum Output {
    Json(Value),
    Bytes(Vec<u8>),
    Empty,
}

impl Output {
    fn json(value: impl Serialize) -> Result<Self, ApiError> {
        Ok(Self::Json(serde_json::to_value(value)?))
    }
}
