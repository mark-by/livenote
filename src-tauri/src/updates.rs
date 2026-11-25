use std::time::Duration;

use anyhow::{Context, Result};
use tauri::{
    AppHandle, Manager, WebviewWindow,
    async_runtime::JoinHandle,
    window::{ProgressBarState, ProgressBarStatus},
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub(super) fn start(app: &AppHandle, shutdown: &CancellationToken) -> Option<JoinHandle<()>> {
    // Локальные сборки без ключа и обычный Linux-бинарник не обновляем.
    #[cfg(target_os = "linux")]
    app.env().appimage.as_ref()?;
    let key = app
        .config()
        .plugins
        .0
        .get("updater")?
        .get("pubkey")?
        .as_str()?;
    if key.trim().is_empty() || shutdown.is_cancelled() {
        return None;
    }
    let window = app.get_webview_window("main")?;
    let shutdown = shutdown.clone();
    Some(tauri::async_runtime::spawn(async move {
        if let Err(error) = check(&window, &shutdown).await {
            eprintln!("Не удалось проверить обновления LiveNote: {error:#}");
        }
    }))
}

async fn check(window: &WebviewWindow, shutdown: &CancellationToken) -> Result<()> {
    let updater = window.updater_builder().build()?;
    let update = tokio::select! {
        () = shutdown.cancelled() => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(15), updater.check()) => result??,
    };
    let Some(update) = update else {
        return Ok(());
    };
    anyhow::ensure!(
        update.download_url.scheme() == "https"
            && update.download_url.host_str() == Some("updates.mark-by.ru"),
        "Сервер вернул недопустимый адрес обновления"
    );

    let (confirmed, answer) = oneshot::channel();
    window.dialog()
        .message(format!(
            "Доступна версия {}. Текущая версия: {}.\nУстановить обновление и перезапустить LiveNote?",
            update.version, update.current_version
        ))
        .title("Обновление LiveNote")
        .parent(window)
        .buttons(MessageDialogButtons::OkCancelCustom("Установить".into(), "Позже".into()))
        .show(move |confirmed_update| {
            let _receiver_may_have_closed = confirmed.send(confirmed_update);
        });
    let accepted = tokio::select! {
        () = shutdown.cancelled() => return Ok(()),
        answer = answer => answer.context("Закрылся канал диалога обновления")?,
    };
    if !accepted {
        return Ok(());
    }

    let result = install(window, shutdown, update).await;
    show_progress(window, ProgressBarStatus::None, None);
    match result {
        Ok(true) if !shutdown.is_cancelled() => window.app_handle().request_restart(),
        Ok(_) => {}
        Err(error) => {
            eprintln!("Не удалось установить обновление LiveNote: {error:#}");
            if !shutdown.is_cancelled() {
                window.dialog()
                    .message("Не удалось установить обновление. Проверьте соединение и права на запись в папку приложения.")
                    .title("Обновление LiveNote")
                    .parent(window)
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    }
    Ok(())
}

async fn install(
    window: &WebviewWindow,
    shutdown: &CancellationToken,
    update: Update,
) -> Result<bool> {
    show_progress(window, ProgressBarStatus::Indeterminate, None);
    let mut loaded = 0u64;
    let mut shown = None;
    let download = update.download(
        |chunk, total| {
            loaded = loaded.saturating_add(u64::try_from(chunk).unwrap_or(u64::MAX));
            let progress = total
                .filter(|&total| total != 0)
                .map(|total| (loaded.saturating_mul(100) / total).min(100));
            if progress != shown {
                show_progress(window, ProgressBarStatus::Normal, progress);
                shown = progress;
            }
        },
        || show_progress(window, ProgressBarStatus::Indeterminate, None),
    );
    let bytes = tokio::select! {
        biased;
        () = shutdown.cancelled() => return Ok(false),
        result = tokio::time::timeout(Duration::from_secs(600), download) => result??,
    };
    // После начала замены файлов завершение приложения ждёт эту задачу.
    tokio::task::spawn_blocking(move || update.install(bytes)).await??;
    Ok(true)
}

fn show_progress(window: &WebviewWindow, status: ProgressBarStatus, progress: Option<u64>) {
    #[cfg(target_os = "linux")]
    {
        let title = match (status, progress) {
            (ProgressBarStatus::None, _) => "LiveNote".to_owned(),
            (_, Some(percent)) => format!("LiveNote — обновление {percent}%"),
            _ => "LiveNote — обновление…".to_owned(),
        };
        if let Err(error) = window.set_title(&title) {
            eprintln!("Не удалось обновить заголовок окна LiveNote: {error}");
        }
    }
    if let Err(error) = window.set_progress_bar(ProgressBarState {
        status: Some(status),
        progress,
    }) {
        eprintln!("Не удалось показать ход обновления LiveNote: {error}");
    }
}
