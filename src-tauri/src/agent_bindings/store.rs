use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::agent_bindings::hash;
use crate::agent_bindings::model::{
    Binding, BindingError, BindingRequest, BindingResult, BindingView, BoundSource, CasBytes, Repo,
    Version, VersionedBytes,
};

pub trait BindingVault {
    fn vault_id(&self) -> &str;
    fn read_bindings(&self) -> BindingResult<Option<VersionedBytes>>;
    fn write_bindings(&self, update: CasBytes) -> BindingResult<Version>;
}

pub struct Bindings {
    local_store_dir: PathBuf,
    operation_lock: Mutex<()>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SharedBindings {
    schema: u32,
    #[serde(default)]
    folders: BTreeMap<String, Repo>,
}

impl Default for SharedBindings {
    fn default() -> Self {
        Self {
            schema: 1,
            folders: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalBindings {
    #[serde(default)]
    folders: BTreeMap<String, PathBuf>,
}

struct Snapshot {
    shared: SharedBindings,
    shared_version: Option<Version>,
    local: LocalBindings,
    local_bytes: Vec<u8>,
}

impl Bindings {
    pub fn new(local_store_dir: impl Into<PathBuf>) -> Self {
        Self {
            local_store_dir: local_store_dir.into(),
            operation_lock: Mutex::new(()),
        }
    }

    pub fn get<V: BindingVault>(&self, vault: &V, folder: &str) -> BindingResult<BindingView> {
        validate_folder(folder)?;
        let _guard = self.lock()?;
        let snapshot = self.snapshot(vault)?;
        Ok(view(&snapshot, folder))
    }

    pub fn put<V: BindingVault>(
        &self,
        vault: &V,
        mut request: BindingRequest,
    ) -> BindingResult<BindingView> {
        validate_folder(&request.folder)?;
        let canonical_local = validate_binding(&request.value)?;
        if canonical_local.is_some() {
            request.value.local_dir = canonical_local;
        }
        let _guard = self.lock()?;
        let mut snapshot = self.snapshot(vault)?;
        let current = view(&snapshot, &request.folder);
        if current.version != request.version {
            return Err(BindingError::new(
                "conflict",
                "Привязка изменилась. Откройте настройки заново.",
            ));
        }

        let old_repo = snapshot.shared.folders.get(&request.folder).cloned();
        let old_local = snapshot.local.folders.get(&request.folder).cloned();
        let shared_changed = old_repo != request.value.repo;
        let local_changed = old_local != request.value.local_dir;

        if shared_changed {
            match &request.value.repo {
                Some(repo) => snapshot
                    .shared
                    .folders
                    .insert(request.folder.clone(), repo.clone()),
                None => snapshot.shared.folders.remove(&request.folder),
            };
            let bytes = serde_json::to_vec(&snapshot.shared).map_err(|error| {
                BindingError::new(
                    "storage",
                    format!("Не удалось сериализовать привязки: {error}"),
                )
            })?;
            let update = CasBytes {
                expected: snapshot.shared_version.clone(),
                bytes,
            };
            snapshot.shared_version = Some(vault.write_bindings(update)?);
        }

        if local_changed {
            match &request.value.local_dir {
                Some(path) => snapshot
                    .local
                    .folders
                    .insert(request.folder.clone(), path.clone()),
                None => snapshot.local.folders.remove(&request.folder),
            };
            snapshot.local_bytes = self.write_local(vault.vault_id(), &snapshot.local)?;
        }

        Ok(view(&snapshot, &request.folder))
    }

    pub fn resolve<V: BindingVault>(
        &self,
        vault: &V,
        folder: &str,
    ) -> BindingResult<Option<BoundSource>> {
        validate_folder(folder)?;
        let _guard = self.lock()?;
        let snapshot = self.snapshot(vault)?;
        let mut candidate = folder.to_string();
        loop {
            let repo = snapshot.shared.folders.get(&candidate).cloned();
            let local_dir = snapshot.local.folders.get(&candidate).cloned();
            if repo.is_some() || local_dir.is_some() {
                return Ok(Some(BoundSource {
                    folder: candidate,
                    repo,
                    local_dir,
                }));
            }
            if candidate.is_empty() {
                return Ok(None);
            }
            candidate = match candidate.rsplit_once('/') {
                Some((parent, _)) => parent.to_string(),
                None => String::new(),
            };
        }
    }

    fn lock(&self) -> BindingResult<std::sync::MutexGuard<'_, ()>> {
        self.operation_lock
            .lock()
            .map_err(|_| BindingError::new("storage", "Блокировка хранилища привязок повреждена."))
    }

    fn snapshot<V: BindingVault>(&self, vault: &V) -> BindingResult<Snapshot> {
        let shared_file = vault.read_bindings()?;
        let (shared, shared_version) = match shared_file {
            Some(file) => {
                let shared: SharedBindings = serde_json::from_slice(&file.bytes).map_err(|_| {
                    BindingError::new("invalid_binding", "Файл общих привязок повреждён.")
                })?;
                if shared.schema != 1 {
                    return Err(BindingError::new(
                        "invalid_binding",
                        "Версия файла общих привязок не поддерживается.",
                    ));
                }
                for (folder, repo) in &shared.folders {
                    validate_folder(folder)?;
                    validate_repo(repo)?;
                }
                (shared, Some(file.version))
            }
            None => (SharedBindings::default(), None),
        };

        let local_bytes = match fs::read(self.local_file(vault.vault_id())) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(_) => {
                return Err(BindingError::new(
                    "storage",
                    "Не удалось прочитать локальные привязки.",
                ));
            }
        };
        let local = if local_bytes.is_empty() {
            LocalBindings::default()
        } else {
            let local: LocalBindings = serde_json::from_slice(&local_bytes).map_err(|_| {
                BindingError::new("invalid_binding", "Файл локальных привязок повреждён.")
            })?;
            for (folder, path) in &local.folders {
                validate_folder(folder)?;
                if !path.is_absolute() {
                    return Err(BindingError::new(
                        "invalid_binding",
                        "Локальная привязка содержит относительный путь.",
                    ));
                }
            }
            local
        };

        Ok(Snapshot {
            shared,
            shared_version,
            local,
            local_bytes,
        })
    }

    fn local_file(&self, vault_id: &str) -> PathBuf {
        self.local_store_dir
            .join(format!("{}.json", hash::reference(vault_id.as_bytes())))
    }

    fn write_local(&self, vault_id: &str, bindings: &LocalBindings) -> BindingResult<Vec<u8>> {
        fs::create_dir_all(&self.local_store_dir).map_err(|_| {
            BindingError::new("storage", "Не удалось создать каталог локальных привязок.")
        })?;
        let bytes = serde_json::to_vec(bindings).map_err(|error| {
            BindingError::new(
                "storage",
                format!("Не удалось сериализовать привязки: {error}"),
            )
        })?;
        let target = self.local_file(vault_id);
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let suffix = COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary =
            self.local_store_dir
                .join(format!(".{}.{}.tmp", std::process::id(), suffix));

        let result = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &target)?;
            Ok(())
        })();
        if result.is_err() {
            drop(fs::remove_file(&temporary));
            return Err(BindingError::new(
                "storage",
                "Не удалось сохранить локальные привязки.",
            ));
        }
        Ok(bytes)
    }
}

fn view(snapshot: &Snapshot, folder: &str) -> BindingView {
    let value = Binding {
        repo: snapshot.shared.folders.get(folder).cloned(),
        local_dir: snapshot.local.folders.get(folder).cloned(),
    };
    let version = if value.repo.is_some() || value.local_dir.is_some() {
        let mut material = Vec::new();
        material.extend_from_slice(folder.as_bytes());
        material.push(0);
        material.extend_from_slice(snapshot.shared_version.as_deref().unwrap_or("").as_bytes());
        material.push(0);
        material.extend_from_slice(&snapshot.local_bytes);
        Some(hash::version(&material))
    } else {
        None
    };
    BindingView { value, version }
}

fn validate_binding(binding: &Binding) -> BindingResult<Option<PathBuf>> {
    if let Some(repo) = &binding.repo {
        validate_repo(repo)?;
    }
    let Some(path) = &binding.local_dir else {
        return Ok(None);
    };
    if !path.is_absolute() {
        return Err(BindingError::new(
            "invalid_path",
            "Локальная директория должна иметь абсолютный путь.",
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| BindingError::new("not_found", "Локальная директория недоступна."))?;
    if !canonical.is_dir() {
        return Err(BindingError::new(
            "invalid_path",
            "Локальная привязка должна указывать на директорию.",
        ));
    }
    Ok(Some(canonical))
}

fn validate_repo(repo: &Repo) -> BindingResult<()> {
    let url = Url::parse(&repo.url)
        .map_err(|_| BindingError::new("invalid_binding", "Адрес репозитория должен быть URL."))?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(BindingError::new(
            "invalid_binding",
            "URL репозитория не должен содержать учётные данные, query или fragment.",
        ));
    }
    Ok(())
}

pub(crate) fn validate_folder(folder: &str) -> BindingResult<()> {
    if folder.is_empty() {
        return Ok(());
    }
    validate_relative(folder, false)
}

pub(crate) fn validate_relative(path: &str, file: bool) -> BindingResult<()> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains('\0')
        || path.ends_with('/')
        || Path::new(path).components().any(|component| {
            !matches!(component, Component::Normal(_)) || component.as_os_str() == ""
        })
    {
        return Err(BindingError::new(
            "invalid_path",
            if file {
                "Путь к файлу должен быть относительным и не содержать переходы между каталогами."
            } else {
                "Путь к папке должен быть относительным и не содержать переходы между каталогами."
            },
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
