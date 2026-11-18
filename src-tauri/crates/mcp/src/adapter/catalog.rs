use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{StorageMode, schema};

/// Операция, которую выполняет сервис `LiveNote`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    /// Перечисляет открытые хранилища.
    ListVaults,
    /// Перечисляет страницы.
    ListPages,
    /// Читает страницу с блоками.
    GetPage,
    /// Создаёт документ.
    AddPage,
    /// Записывает блок Markdown.
    WriteMarkdown,
    /// Записывает блок диаграммы.
    WriteDiagram,
    /// Проверяет блок диаграммы.
    CheckDiagram,
    /// Пересчитывает расположение элементов BPMN.
    LayoutDiagram,
    /// Обновляет заголовок или состав блоков страницы.
    UpdatePage,
    /// Удаляет страницу.
    DeletePage,
    /// Читает дерево и метаданные хранилища.
    GetVault,
    /// Читает исходный документ.
    GetDocument,
    /// Записывает исходный документ и его ресурсы.
    WriteDocument,
    /// Создаёт папку.
    CreateFolder,
    /// Перемещает папку.
    MoveFolder,
    /// Удаляет папку.
    DeleteFolder,
    /// Перемещает документ.
    MoveDocument,
}

/// Идентификатор хранилища, переданный клиентом.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultId(String);

impl VaultId {
    /// Возвращает идентификатор для поиска в реестре.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Вызов инструмента после проверки и нормализации аргументов.
#[derive(Debug)]
#[non_exhaustive]
pub struct ToolCall {
    /// Идентификатор операции.
    pub tool: Tool,
    /// Явно выбранное хранилище. Сервис обрабатывает отсутствие идентификатора.
    pub vault_id: Option<VaultId>,
    /// Проверенные аргументы с именами из MCP-схемы, без `vault_id`.
    pub arguments: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    name: Tool,
    description: String,
    input_schema: Value,
    execution: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_schema: Option<Value>,
}

// Схемы получены из tools/list SDK 1.31.0 в режиме Vaults.
static TOOLS: LazyLock<Result<Vec<Definition>, serde_json::Error>> =
    LazyLock::new(|| serde_json::from_str(include_str!("tools.json")));

#[derive(Debug, thiserror::Error)]
pub(super) enum CallError {
    #[error("MCP error -32602: Tool {0} not found")]
    Unknown(String),
    #[error(
        "MCP error -32602: Input validation error: Invalid arguments for tool {name}: {issues}"
    )]
    Invalid { name: String, issues: String },
    #[error("{0}")]
    Catalog(#[from] &'static serde_json::Error),
}

impl Definition {
    fn input(&self, mode: StorageMode) -> Value {
        if mode == StorageMode::Vaults || self.name == Tool::ListVaults {
            return self.input_schema.clone();
        }
        if matches!(self.name, Tool::ListPages | Tool::GetVault) {
            return json!({"type": "object", "properties": {}});
        }
        let mut input = self.input_schema.clone();
        if let Some(properties) = input.get_mut("properties").and_then(Value::as_object_mut) {
            properties.shift_remove("vault_id");
        }
        input
    }
}

pub(super) fn list(mode: StorageMode) -> Result<Vec<Value>, CallError> {
    TOOLS
        .as_ref()?
        .iter()
        .filter(|tool| mode == StorageMode::Vaults || tool.name != Tool::ListVaults)
        .map(|tool| {
            Ok(json!(Definition {
                input_schema: tool.input(mode),
                ..tool.clone()
            }))
        })
        .collect()
}

pub(super) fn parse(
    mode: StorageMode,
    name: &str,
    arguments: Option<Map<String, Value>>,
) -> Result<ToolCall, CallError> {
    let unknown = || CallError::Unknown(name.to_owned());
    let tool: Tool = serde::Deserialize::deserialize(serde::de::value::StrDeserializer::<
        serde::de::value::Error,
    >::new(name))
    .map_err(|_| unknown())?;
    if mode == StorageMode::Sqlite && tool == Tool::ListVaults {
        return Err(unknown());
    }
    let definition = TOOLS
        .as_ref()?
        .iter()
        .find(|def| def.name == tool)
        .ok_or_else(unknown)?;
    let arguments = if matches!(tool, Tool::ListVaults | Tool::ListPages | Tool::GetVault) {
        arguments.unwrap_or_default()
    } else {
        arguments.ok_or_else(|| CallError::Invalid {
            name: name.to_owned(),
            issues: "Required".to_owned(),
        })?
    };
    let mut arguments =
        schema::parse(&definition.input(mode), arguments).map_err(|issues| CallError::Invalid {
            name: name.to_owned(),
            issues,
        })?;
    let vault_id = match arguments.shift_remove("vault_id") {
        Some(Value::String(id)) => Some(VaultId(id)),
        _ => None,
    };
    if tool == Tool::WriteDiagram && arguments.get("format").and_then(Value::as_str) != Some("bpmn")
    {
        arguments.shift_remove("layout");
    }
    Ok(ToolCall {
        tool,
        vault_id,
        arguments,
    })
}
