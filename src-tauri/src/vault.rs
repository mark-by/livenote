use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{self, Write},
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultConfig {
    vault_path: PathBuf,
}

pub(super) fn lock_instance(dir: &Path) -> Result<Option<File>> {
    fs::create_dir_all(dir).context("Не удалось создать каталог настроек LiveNote")?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("instance.lock"))
        .context("Не удалось открыть файл блокировки LiveNote")?;
    match lock.try_lock() {
        Ok(()) => Ok(Some(lock)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => {
            Err(error).context("Не удалось заблокировать запуск LiveNote")
        }
    }
}

fn usable_vault(path: &Path) -> bool {
    path.is_absolute() && path.to_str().is_some() && fs::read_dir(path).is_ok()
}

pub(super) async fn select(app: &AppHandle, config_dir: &Path) -> Result<Option<PathBuf>> {
    let config_file = config_dir.join("vault.json");
    match fs::read(&config_file) {
        Ok(bytes) => {
            if let Ok(config) = serde_json::from_slice::<VaultConfig>(&bytes)
                && usable_vault(&config.vault_path)
            {
                return Ok(Some(config.vault_path));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("Не удалось прочитать настройки LiveNote"),
    }

    let (selected, wait) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Выберите папку для LiveNote")
        .pick_folder(move |folder| {
            drop(selected.send(folder));
        });
    let Some(folder) = wait
        .await
        .context("Не удалось открыть диалог выбора папки")?
    else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .context("Системный диалог не вернул путь к папке")?;
    anyhow::ensure!(usable_vault(&path), "Нет доступа к выбранной папке");

    let config = VaultConfig { vault_path: path };
    let mut tmp = tempfile::NamedTempFile::new_in(config_dir)
        .context("Не удалось создать временный файл настроек LiveNote")?;
    serde_json::to_writer(&mut tmp, &config).context("Не удалось сохранить путь к папке")?;
    writeln!(tmp).context("Не удалось записать настройки LiveNote")?;
    tmp.persist(config_file)
        .context("Не удалось заменить файл настроек LiveNote")?;
    Ok(Some(config.vault_path))
}
