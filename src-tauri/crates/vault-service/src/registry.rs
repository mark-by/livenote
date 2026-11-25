use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    sync::{broadcast, watch},
    task::spawn_blocking,
    time::Instant,
};
use vault_read::vault_id_for_root;

use crate::{ApiError, Scope, events, state::State};

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;

const GRACE: Duration = Duration::from_secs(30);

pub struct Registry {
    entries: Mutex<Entries>,
}

struct Entries {
    opened: Vec<Arc<Entry>>,
    opening: HashMap<PathBuf, watch::Sender<bool>>,
}

enum OpenStatus {
    Ready(Value),
    Pending(watch::Receiver<bool>),
    Reserved(Reservation),
}

struct Reservation {
    registry: Arc<Registry>,
    root: PathBuf,
}

impl Registry {
    pub fn new(startup: Entry) -> Self {
        Self {
            entries: Mutex::new(Entries {
                opened: vec![Arc::new(startup)],
                opening: HashMap::new(),
            }),
        }
    }

    pub fn select(&self, scope: Scope<'_>, startup: &str) -> Result<Arc<Entry>, ApiError> {
        let entries = self.entries.lock().map_err(ApiError::internal)?;
        select(&entries.opened, scope, startup)
    }

    pub fn list(&self) -> Result<Vec<Value>, ApiError> {
        let entries = self.entries.lock().map_err(ApiError::internal)?;
        Ok(entries
            .opened
            .iter()
            .map(|entry| entry.descriptor())
            .collect())
    }

    pub async fn open_selected(self: &Arc<Self>, path: PathBuf) -> Result<Value, ApiError> {
        let root = blocking(move || canonicalize(&path, false)).await?;
        loop {
            match self.reserve(&root)? {
                OpenStatus::Ready(descriptor) => return Ok(descriptor),
                OpenStatus::Pending(mut done) => {
                    drop(
                        done.wait_for(|finished| *finished)
                            .await
                            .map_err(ApiError::internal)?,
                    );
                }
                OpenStatus::Reserved(reservation) => {
                    // Резерв остаётся у фоновой задачи, даже если клиент отменил запрос.
                    return blocking(move || reservation.open()).await;
                }
            }
        }
    }

    fn reserve(self: &Arc<Self>, root: &Path) -> Result<OpenStatus, ApiError> {
        let mut entries = self.entries.lock().map_err(ApiError::internal)?;
        if let Some(entry) = entries.opened.iter().find(|entry| entry.root == root) {
            entry.touch();
            return Ok(OpenStatus::Ready(entry.descriptor()));
        }
        if let Some(pending) = entries.opening.get(root) {
            return Ok(OpenStatus::Pending(pending.subscribe()));
        }
        entries
            .opening
            .insert(root.to_owned(), watch::Sender::new(false));
        Ok(OpenStatus::Reserved(Reservation {
            registry: Arc::clone(self),
            root: root.to_owned(),
        }))
    }
}

impl Reservation {
    fn open(self) -> Result<Value, ApiError> {
        let entry = Entry::open(self.root.clone(), false)?;
        let descriptor = entry.descriptor();
        let mut entries = self.registry.entries.lock().map_err(ApiError::internal)?;
        if entries.opened.iter().any(|other| other.id == entry.id) {
            return Err(ApiError::new(
                409,
                "vault_id_collision",
                "Идентификаторы хранилищ совпали",
            ));
        }
        entries.opened.push(Arc::new(entry));
        Ok(descriptor)
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let pending = self
            .registry
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .opening
            .remove(&self.root);
        if let Some(pending) = pending {
            pending.send_replace(true);
        }
    }
}

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
        #[cfg(test)]
        tests::pause_before_scan(&root);
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

fn select(entries: &[Arc<Entry>], scope: Scope<'_>, startup: &str) -> Result<Arc<Entry>, ApiError> {
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
                    let mut state = registry.entries.lock().map_err(ApiError::internal)?;
                    let entries = &mut state.opened;
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
