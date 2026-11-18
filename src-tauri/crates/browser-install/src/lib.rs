//! Установка Chrome Headless Shell в локальный каталог данных Tauri.
#![cfg(unix)]

mod archive;
mod download;

use anyhow::{Context, Result};
use download::{Artifact, VERSION};
use std::{
    fs, io,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use tokio::task::spawn_blocking;

const EXECUTABLE: &str = "chrome-headless-shell";

/// Возвращает путь к установленной версии. Не обращается к сети.
///
/// # Errors
/// Возвращает ошибку, если платформа не поддерживается или каталог недоступен.
pub async fn installed(data_dir: &Path) -> anyhow::Result<Option<PathBuf>> {
    let destination = installation_dir(data_dir, Artifact::current()?);
    spawn_blocking(move || executable_at(&destination))
        .await
        .context("Не удалось завершить поиск Chrome Headless Shell")?
}

/// Устанавливает Chrome Headless Shell после согласия пользователя.
/// Если эта версия уже установлена, возвращает её путь без загрузки.
///
/// # Errors
/// Возвращает ошибку при сбое загрузки, проверки архива или записи файлов.
pub async fn install(data_dir: &Path) -> anyhow::Result<PathBuf> {
    let artifact = Artifact::current()?;
    let destination = installation_dir(data_dir, artifact);
    if let Some(path) = installed(data_dir).await? {
        return Ok(path);
    }

    let parent = destination
        .parent()
        .context("Не задан каталог установки Chrome Headless Shell")?
        .to_path_buf();
    let staging = spawn_blocking(move || -> Result<_> {
        fs::create_dir_all(&parent)
            .context("Не удалось создать каталог для Chrome Headless Shell")?;
        tempfile::tempdir_in(parent).context("Не удалось создать временный каталог для загрузки")
    })
    .await
    .context("Не удалось подготовить каталог установки")??;

    let archive_path = staging.path().join("download.zip");
    download::verified_zip(artifact, &archive_path).await?;

    // После начала распаковки эта операция завершится даже при отмене ожидания.
    spawn_blocking(move || {
        let archive_dir = format!("chrome-headless-shell-{}", artifact.platform);
        let payload = staging.path().join(&archive_dir);
        archive::extract(fs::File::open(archive_path)?, staging.path(), &archive_dir)?;
        executable_at(&payload)?
            .context("В архиве нет исполняемого файла Chrome Headless Shell")?;

        // Переносим весь каталог одной операцией в пределах одной файловой системы.
        match fs::rename(payload, &destination) {
            Ok(()) => Ok(destination.join(EXECUTABLE)),
            Err(error) => {
                // Другая копия приложения могла установить эту же версию первой.
                executable_at(&destination)?
                    .context(error)
                    .context("Не удалось переместить Chrome Headless Shell в каталог установки")
            }
        }
    })
    .await
    .context("Не удалось завершить установку Chrome Headless Shell")?
}

fn installation_dir(data_dir: &Path, artifact: Artifact) -> PathBuf {
    data_dir
        .join(EXECUTABLE)
        .join(VERSION)
        .join(artifact.platform)
}

fn executable_at(directory: &Path) -> Result<Option<PathBuf>> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).context("Не удалось прочитать каталог Chrome Headless Shell");
        }
    }

    let path = directory.join(EXECUTABLE);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.permissions().mode() & 0o100 != 0 => {
            Ok(Some(path))
        }
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            Err(error).context("Не удалось проверить исполняемый файл Chrome Headless Shell")
        }
    }
}
