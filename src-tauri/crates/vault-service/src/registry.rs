use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{sync::broadcast, task::spawn_blocking, time::Instant};
use vault_read::vault_id_for_root;

use crate::{ApiError, Scope, events, state::State};

const GRACE: Duration = Duration::from_secs(30);

pub type Registry = Mutex<Vec<Arc<Entry>>>;

pub struct Entry {
    pub(crate) id: String,
    name: String,
    root: PathBuf,
    pinned: bool,
    idle_since: Mutex<Instant>,
    pub(crate) events: broadcast::Sender<Value>,
    state: Mutex<State>,
}

impl Entry {
    pub(crate) fn open(root: PathBuf, pinned: bool) -> Result<Self, ApiError> {
        let canonical = root
            .to_str()
            .ok_or_else(|| ApiError::invalid("Путь хранилища должен быть в UTF-8"))?;
        let id = vault_id_for_root(canonical);
        let name = root
            .file_name()
            .and_then(|part| part.to_str())
            .unwrap_or(canonical)
            .to_owned();
        let (events, _) = broadcast::channel(256);
        let state = State::open(&root, &name, events.clone())?;
        Ok(Self {
            id,
            name,
            root,
            pinned,
            idle_since: Mutex::new(Instant::now()),
            events,
            state: Mutex::new(state),
        })
    }

    pub(crate) fn descriptor(&self) -> Value {
        json!({"id": self.id, "name": self.name})
    }

    pub(crate) fn touch(&self) {
        *self
            .idle_since
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Instant::now();
    }

    pub(crate) fn access<T>(
        &self,
        action: impl FnOnce(&mut State) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let mut state = self.state.lock().map_err(ApiError::internal)?;
        action(&mut state)
    }
}

pub async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    spawn_blocking(action).await.map_err(ApiError::internal)?
}

pub fn select(
    entries: &[Arc<Entry>],
    scope: Scope<'_>,
    startup: &str,
) -> Result<Arc<Entry>, ApiError> {
    let id = match scope {
        Scope::Vault(id) => id,
        Scope::Mcp if entries.len() > 1 => {
            return Err(ApiError::new(409, "vault_required", "Укажите vault_id"));
        }
        Scope::Default | Scope::Mcp => startup,
    };
    entries
        .iter()
        .find(|entry| entry.id == id)
        .cloned()
        .ok_or_else(|| {
            ApiError::new(404, "vault_not_found", "Vault не открыт").details(json!({"vaultId": id}))
        })
}

pub fn canonicalize(path: &Path, pinned: bool) -> Result<PathBuf, ApiError> {
    if pinned {
        std::fs::create_dir_all(path).map_err(ApiError::internal)?;
    }
    let root = path
        .canonicalize()
        .map_err(|error| ApiError::invalid(error.to_string()))?;
    if !root.is_dir() {
        return Err(ApiError::invalid("Vault должен быть каталогом"));
    }
    Ok(root)
}

pub fn open_selected(registry: &Registry, path: &Path) -> Result<Value, ApiError> {
    let root = canonicalize(path, false)?;
    let mut entries = registry.lock().map_err(ApiError::internal)?;
    if let Some(entry) = entries.iter().find(|entry| entry.root == root) {
        entry.touch();
        return Ok(entry.descriptor());
    }
    let entry = Entry::open(root, false)?;
    if entries.iter().any(|other| other.id == entry.id) {
        return Err(ApiError::new(
            409,
            "vault_id_collision",
            "Идентификаторы хранилищ совпали",
        ));
    }
    let descriptor = entry.descriptor();
    entries.push(Arc::new(entry));
    drop(entries);
    Ok(descriptor)
}

pub fn watch(registry: &Arc<Registry>) -> tokio::task::AbortHandle {
    let registry = Arc::downgrade(registry);
    tokio::spawn(async move {
        let period = Duration::from_secs(1);
        let start = Instant::now() + period;
        let mut ticks = tokio::time::interval_at(start, period);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticks.tick().await;
            let Some(registry) = registry.upgrade() else {
                break;
            };
            let result = blocking(move || {
                let watch = {
                    let mut entries = registry.lock().map_err(ApiError::internal)?;
                    entries.retain(|entry| {
                        entry.pinned
                            || entry.events.receiver_count() > 0
                            || Arc::strong_count(entry) > 1
                            || entry
                                .idle_since
                                .lock()
                                .is_ok_and(|idle| idle.elapsed() < GRACE)
                    });
                    entries
                        .iter()
                        .filter(|entry| entry.events.receiver_count() > 0)
                        .cloned()
                        .collect::<Vec<_>>()
                };
                for entry in watch {
                    if entry.access(|state| state.refresh(true)).is_err() {
                        events::publish(&entry.events, events::event("vault.updated", "", 0));
                    }
                }
                Ok(())
            })
            .await;
            if result.is_err() {
                break;
            }
        }
    })
    .abort_handle()
}
