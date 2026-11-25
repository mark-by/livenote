mod agent;
pub mod agent_bindings;
pub mod agent_connections;
mod chromium;
mod http;
mod server;
#[cfg(all(not(debug_assertions), any(target_os = "macos", target_os = "linux")))]
mod updates;
mod vault;
mod window;

use anyhow::{Context, Result};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

async fn run_desktop(app: &AppHandle, shutdown: &CancellationToken) -> Result<()> {
    let config_dir = app.path().app_config_dir()?;
    let Some(_instance) = vault::lock_instance(&config_dir)? else {
        // Второй запуск с тем же каталогом настроек не открывает диалог и не запускает сервер.
        return Ok(());
    };
    let data_dir = app.path().app_local_data_dir()?;
    let Some(chromium) = chromium::require(app, &data_dir, shutdown).await? else {
        return Ok(());
    };
    let selected = tokio::select! {
        biased;
        () = shutdown.cancelled() => return Ok(()),
        selected = vault::select(app, &config_dir) => selected?,
    };
    let Some(vault_path) = selected else {
        return Ok(());
    };
    server::run(app, &vault_path, chromium, shutdown).await
}

fn launch() -> Result<()> {
    let shutdown = CancellationToken::new();
    let exit_ready = Arc::new(AtomicBool::new(false));
    let worker_shutdown = shutdown.clone();
    let worker_exit_ready = Arc::clone(&exit_ready);
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(all(not(debug_assertions), any(target_os = "macos", target_os = "linux")))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
        .setup(move |app| {
            let app = app.handle().clone();
            // Нативный цикл обрабатывает диалоги и окна, пока сервер запускается в фоне.
            drop(tauri::async_runtime::spawn(async move {
                let code = match run_desktop(&app, &worker_shutdown).await {
                    Ok(()) => 0,
                    Err(error) => {
                        eprintln!("LiveNote: {error:#}");
                        // Окна не должны продолжать работу, если сервер больше не принадлежит GUI.
                        for window in app.webview_windows().into_values() {
                            if let Err(error) = window.destroy() {
                                eprintln!("Не удалось закрыть окно LiveNote: {error}");
                            }
                        }
                        let (dismissed, wait) = oneshot::channel();
                        app.dialog()
                            .message(format!("{error}"))
                            .title("LiveNote")
                            .kind(MessageDialogKind::Error)
                            .buttons(MessageDialogButtons::OkCustom("Закрыть".into()))
                            .show(move |_| {
                                drop(dismissed.send(()));
                            });
                        match wait.await {
                            Ok(()) => {}
                            Err(error) => {
                                eprintln!("Не удалось показать сообщение LiveNote: {error}")
                            }
                        }
                        1
                    }
                };
                worker_exit_ready.store(true, Ordering::Release);
                app.exit(code);
            }));
            Ok(())
        })
        .build(tauri::generate_context!())
        .context("Не удалось создать приложение LiveNote")?;

    app.run(move |_app, event| match event {
        RunEvent::ExitRequested { api, .. } if !exit_ready.load(Ordering::Acquire) => {
            api.prevent_exit();
            shutdown.cancel();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: true,
            ..
        } => {
            if let Some(window) = _app.get_webview_window("main")
                && let Err(error) = window.set_focus()
            {
                eprintln!("Не удалось активировать окно LiveNote: {error}");
            }
        }
        _ => {}
    });
    Ok(())
}

fn main() {
    if let Err(error) = launch() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
