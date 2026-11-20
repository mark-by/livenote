use anyhow::{Context, Result};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Url, WebviewUrl, WebviewWindowBuilder, Wry, webview::NewWindowResponse};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

fn local_site(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(super::server::PORT)
        && url.username().is_empty()
        && url.password().is_none()
}

fn local_navigation(url: &Url) -> bool {
    local_site(url)
        || url.as_str() == "about:blank"
        || (url.scheme() == "blob"
            && Url::parse(url.path()).is_ok_and(|origin| local_site(&origin)))
}

fn builder<'a>(
    app: &'a AppHandle,
    label: &str,
    url: Url,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let parent = app.clone();
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("LiveNote")
        .inner_size(1240.0, 820.0)
        // Дерево файлов обрабатывает перетаскивание через события HTML5.
        .disable_drag_drop_handler()
        .on_navigation(local_navigation)
        .on_new_window(move |url, features| {
            if url.as_str() == "about:blank" || local_site(&url) {
                // Меню сначала резервирует пустое окно, затем открывает в нём выбранное хранилище.
                let label = format!("vault-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
                match builder(&parent, &label, url)
                    .window_features(features)
                    .build()
                {
                    Ok(window) => return NewWindowResponse::Create { window },
                    Err(error) => eprintln!("Не удалось открыть окно LiveNote: {error}"),
                }
            } else if matches!(url.scheme(), "http" | "https")
                && let Err(error) = open::that_detached(url.as_str())
            {
                eprintln!("Не удалось открыть ссылку в системном браузере: {error}");
            }
            NewWindowResponse::Deny
        });

    #[cfg(target_os = "macos")]
    let window = window
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 24.0))
        .accept_first_mouse(true)
        .initialization_script("window.__LIVENOTE_MACOS_TITLEBAR__ = true;");

    window
}

pub(super) async fn open(app: &AppHandle, shutdown: &CancellationToken) -> Result<()> {
    let url = Url::parse(&format!("http://127.0.0.1:{}", super::server::PORT))?;
    let (created, wait) = oneshot::channel();
    let handle = app.clone();
    let shutdown = shutdown.clone();
    app.run_on_main_thread(move || {
        let result = if shutdown.is_cancelled() {
            Ok(())
        } else {
            builder(&handle, "main", url).build().map(|_| ())
        };
        drop(created.send(result));
    })?;
    wait.await.context("Не удалось создать окно LiveNote")??;
    Ok(())
}
