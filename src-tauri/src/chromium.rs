use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use browser_install::{install, installed};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub(super) async fn require(
    app: &AppHandle,
    data_dir: &Path,
    shutdown: &CancellationToken,
) -> Result<Option<PathBuf>> {
    if let Some(path) = installed(data_dir)
        .await
        .context("Не удалось проверить установленный Chromium")?
    {
        return Ok(Some(path));
    }

    let mut prompt = String::from(
        "LiveNote использует Chromium для проверки диаграмм. \
         Установите Chromium для запуска LiveNote. \
         После установки доступ к сети не нужен.",
    );
    let mut button = "Установить";
    let mut kind = MessageDialogKind::Info;
    loop {
        let (accepted, wait) = oneshot::channel();
        app.dialog()
            .message(&prompt)
            .title("Установка Chromium")
            .kind(kind)
            .buttons(MessageDialogButtons::OkCancelCustom(
                button.into(),
                "Выйти".into(),
            ))
            .show(move |result| drop(accepted.send(result)));
        let accepted = tokio::select! {
            biased;
            () = shutdown.cancelled() => return Ok(None),
            answer = wait => answer.context("Не удалось показать окно установки Chromium")?,
        };
        if !accepted {
            return Ok(None);
        }
        let result = tokio::select! {
            biased;
            () = shutdown.cancelled() => return Ok(None),
            result = install(data_dir) => result,
        };
        match result {
            Ok(path) => return Ok(Some(path)),
            Err(error) => {
                eprintln!("Не удалось установить Chromium: {error:#}");
                prompt = format!(
                    "Не удалось установить Chromium.\n\n{error}\n\n\
                     Проверьте подключение к сети и повторите установку."
                );
                button = "Повторить";
                kind = MessageDialogKind::Error;
            }
        }
    }
}
