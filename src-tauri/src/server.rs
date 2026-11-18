use std::{
    env,
    io::ErrorKind,
    net::{Ipv4Addr, SocketAddrV4},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use livenote_diagrams::{DiagramEngine, MermaidTheme};
use livenote_vault_service::Service;
use tauri::AppHandle;
#[cfg(not(debug_assertions))]
use tauri::Manager;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

pub(super) const PORT: u16 = 4317;

fn web_root(_app: &AppHandle) -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    let web_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/web");
    #[cfg(not(debug_assertions))]
    let web_root = _app
        .path()
        .resource_dir()
        .context("Не удалось определить каталог ресурсов LiveNote")?
        .join("web");
    let web_root = web_root.canonicalize().with_context(|| {
        format!(
            "Не удалось открыть каталог интерфейса {}",
            web_root.display()
        )
    })?;
    for file in ["index.html", "diagram-worker.html", "drawio/index.html"] {
        anyhow::ensure!(
            web_root.join(file).is_file(),
            "Файл {file} отсутствует в ресурсах LiveNote"
        );
    }
    Ok(web_root)
}

pub(super) async fn run(
    app: &AppHandle,
    vault: &Path,
    chromium: PathBuf,
    shutdown: &CancellationToken,
) -> Result<()> {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, PORT);
    let listener = match TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == ErrorKind::AddrInUse => {
            bail!(
                "Порт {address} занят. Остановите службу, которая занимает этот порт, и запустите LiveNote снова."
            )
        }
        Err(error) => return Err(error).context("Не удалось открыть порт LiveNote"),
    };

    let web_root = web_root(app)?;
    let engine = DiagramEngine::new(chromium, web_root.clone());
    let theme = env::var("LIVENOTE_THEME").unwrap_or_else(|_| String::from("default"));
    let _: MermaidTheme = serde_json::from_value(serde_json::Value::String(theme.clone()))
        .with_context(|| format!("Неизвестная тема Mermaid «{theme}»"))?;
    let token = env::var("LIVENOTE_TOKEN")
        .ok()
        .map(|token| token.trim().to_owned())
        .filter(|token| !token.is_empty());
    tokio::select! {
        biased;
        () = shutdown.cancelled() => return Ok(()),
        ready = engine.warm_up() => ready.context("Не удалось запустить проверку диаграмм в Chromium")?,
    }
    let service = Service::open(vault, engine, theme.clone())
        .await
        .map_err(|error| anyhow!("Не удалось открыть папку LiveNote: {}", error.message))?;
    if shutdown.is_cancelled() {
        return Ok(());
    }

    let state =
        super::http::HttpState::new(service, app.clone(), shutdown.clone(), PORT, token, theme);
    let router = super::http::router(state, &web_root);
    let serving = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown.clone().cancelled_owned())
        .into_future();
    tokio::pin!(serving);
    tokio::select! {
        result = &mut serving => return result.context("Ошибка HTTP-сервера LiveNote"),
        window = super::window::open(app, shutdown) => {
            if let Err(error) = window {
                shutdown.cancel();
                serving.await.context("Не удалось остановить HTTP-сервер LiveNote")?;
                return Err(error);
            }
        }
    }
    if !shutdown.is_cancelled() {
        println!("LiveNote: http://{address}/ (MCP: /mcp)");
    }
    serving.await.context("Ошибка HTTP-сервера LiveNote")
}
