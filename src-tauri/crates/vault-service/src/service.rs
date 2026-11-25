use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use livenote_diagrams::DiagramEngine;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::{
    ApiError, BlockResult, Output, Scope, Subscription,
    agent_documents::VaultRef,
    args,
    diagram::Validator,
    operations::immediate,
    registry::{Entry, Registry, blocking, canonicalize, watch},
    state::State,
};

/// Общая точка входа в сценарии REST и MCP.
pub struct Service {
    startup: String,
    registry: Arc<Registry>,
    watcher: tokio::task::AbortHandle,
    pub(crate) validator: Arc<Validator>,
}

impl Service {
    /// Открывает стартовое хранилище и запускает наблюдение за изменениями.
    ///
    /// # Errors
    /// Возвращает ошибку пути, блокировки хранилища или темы.
    pub async fn open(
        startup: &Path,
        diagrams: DiagramEngine,
        theme: String,
    ) -> Result<Self, ApiError> {
        let theme = decode(Value::String(theme))?;
        let path = startup.to_owned();
        let entry = blocking(move || Entry::open(canonicalize(&path, true)?, true)).await?;
        let startup = entry.id.clone();
        let registry = Arc::new(Registry::new(entry));
        let watcher = watch(&registry);
        Ok(Self {
            startup,
            registry,
            watcher,
            validator: Arc::new(Validator {
                engine: diagrams,
                theme,
            }),
        })
    }

    /// Открывает каталог, выбранный пользователем, и возвращает `id` и `name`.
    ///
    /// # Errors
    /// Возвращает ошибку пути или блокировки хранилища.
    pub async fn open_selected(&self, path: PathBuf) -> Result<Value, ApiError> {
        self.registry.open_selected(path).await
    }

    /// Возвращает идентификатор стартового хранилища.
    #[must_use]
    pub fn startup_id(&self) -> &str {
        &self.startup
    }

    /// Подписывается на события указанного или стартового хранилища.
    ///
    /// # Errors
    /// Возвращает ошибку, если указанное хранилище закрыто.
    pub async fn subscribe(&self, vault_id: Option<&str>) -> Result<Subscription, ApiError> {
        let scope = vault_id.map_or(Scope::Default, Scope::Vault);
        let entry = self.entry(scope)?;
        blocking(move || Ok(Subscription::new(&entry))).await
    }

    fn entry(&self, scope: Scope<'_>) -> Result<Arc<Entry>, ApiError> {
        self.registry.select(scope, &self.startup)
    }

    /// Выбирает открытое хранилище по явному идентификатору.
    ///
    /// # Errors
    /// Возвращает ошибку, если хранилище не открыто.
    pub fn agent_vault(&self, vault_id: &str) -> Result<VaultRef, ApiError> {
        let entry = self.entry(Scope::Vault(vault_id))?;
        Ok(VaultRef::new(entry, Arc::clone(&self.validator)))
    }

    /// Выполняет запись блока и возвращает страницу вместе с результатом проверки.
    ///
    /// # Errors
    /// Возвращает ошибки записи или конфликт, если ревизия квитанции уже недоступна.
    pub async fn call_block(
        &self,
        operation: &str,
        arguments: Value,
        scope: Scope<'_>,
    ) -> Result<BlockResult, ApiError> {
        let entry = self.entry_for_call(&arguments, scope)?;
        self.block_action(entry, operation, arguments, BlockResult::from_summary)
            .await
    }

    /// Выполняет операцию в выбранном хранилище.
    ///
    /// # Errors
    /// Возвращает ошибки аргументов, проверки, конфликтов и файловых операций.
    pub async fn call(
        &self,
        operation: &str,
        arguments: Value,
        scope: Scope<'_>,
    ) -> Result<Output, ApiError> {
        if operation == "list_vaults" {
            let vaults = self.registry.list()?;
            return Ok(Output::Json(json!({"vaults": vaults})));
        }
        let entry = self.entry_for_call(&arguments, scope)?;
        match operation {
            "add_page" | "import_markdown" | "write_document" => {
                self.document_action(entry, operation, arguments).await
            }
            "write_markdown" | "write_diagram" | "replace_block" | "layout_diagram" => {
                self.block_action(entry, operation, arguments, |_, summary| {
                    Output::json(summary)
                })
                .await
            }
            "check_diagram" | "export_png" => {
                let args = decode(arguments)?;
                let check = access(entry, |state| state.diagram(args)).await?;
                self.validator.check(check, operation == "export_png").await
            }
            _ => {
                let operation = operation.to_owned();
                access(entry, move |state| immediate(state, &operation, arguments)).await
            }
        }
    }

    fn entry_for_call(&self, arguments: &Value, scope: Scope<'_>) -> Result<Arc<Entry>, ApiError> {
        let scope = match scope {
            Scope::Mcp => arguments.get("vault_id").map_or(Ok(Scope::Mcp), |value| {
                value
                    .as_str()
                    .map(Scope::Vault)
                    .ok_or_else(|| ApiError::invalid("vault_id должен быть строкой"))
            })?,
            Scope::Default | Scope::Vault(_) => scope,
        };
        self.entry(scope)
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.watcher.abort();
    }
}

pub async fn access<T: Send + 'static>(
    entry: Arc<Entry>,
    action: impl FnOnce(&mut State) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    blocking(move || {
        entry.access(|state| {
            state.refresh(true)?;
            action(state)
        })
    })
    .await
}

pub fn decode<T: DeserializeOwned>(args: Value) -> Result<T, ApiError> {
    serde_json::from_value(args).map_err(|error| ApiError::invalid(error.to_string()))
}

pub fn require_version(expected: &args::Expected) -> Result<(), ApiError> {
    if expected.expected_version.is_none() {
        return Err(ApiError::invalid("Требуется expected_version"));
    }
    Ok(())
}
