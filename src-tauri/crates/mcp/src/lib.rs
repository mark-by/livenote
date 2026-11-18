//! Адаптер MCP для POST с ответом JSON. Не хранит сессии и не выбирает хранилище.

mod adapter;

pub use adapter::{Config, Response, StorageMode, Tool, ToolCall, ToolError, VaultId, handle};
