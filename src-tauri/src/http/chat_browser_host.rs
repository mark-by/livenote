use std::{
    env,
    io::{self, Read, Write},
    net::Ipv4Addr,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, ensure};
use livenote_diagrams::DiagramEngine;
use tokio::net::TcpListener;

use super::{AgentRuntime, CancellationToken, HttpState, Semaphore, Service, router, security};
use crate::agent_connections::Connections;

#[tokio::test]
#[ignore = "Запускает HTTP-сервер по запросу браузерного теста"]
async fn serve_chat_browser_fixture() -> Result<()> {
    let root =
        PathBuf::from(env::var_os("LIVENOTE_CHAT_FIXTURE_ROOT").context("Не задан каталог теста")?);
    let token = env::var("LIVENOTE_CHAT_FIXTURE_TOKEN").context("Не задан токен теста")?;
    ensure!(!token.is_empty(), "Токен теста пуст");
    let web_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/web");
    ensure!(
        web_root.join("index.html").is_file(),
        "Сначала соберите интерфейс: node node_modules/vite/bin/vite.js build --mode desktop"
    );

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let address = listener.local_addr()?;
    let data = root.join("data");
    let shutdown = CancellationToken::new();
    let theme = String::from("default");
    let chromium = match env::var_os("LIVENOTE_CHAT_FIXTURE_CHROMIUM") {
        Some(path) => {
            let path = PathBuf::from(path);
            ensure!(
                path.is_absolute() && path.is_file(),
                "Укажите абсолютный путь к Chromium для теста"
            );
            path
        }
        None => root.join("no-browser"),
    };
    let engine = DiagramEngine::new(chromium, web_root.clone());
    let service = Service::open(&root.join("vault"), engine, theme.clone())
        .await
        .map_err(|error| anyhow!("Не удалось открыть тестовое хранилище: {}", error.message))?;
    let connections = Connections::fixture(data.clone(), address.port())?;
    let agent = AgentRuntime::new(data, connections, shutdown.clone());
    let state = HttpState {
        service: service.into(),
        shutdown: shutdown.clone(),
        app: None,
        access: security::Access::new(address.port(), Some(token)),
        theme: theme.into(),
        picker: Semaphore::new(1).into(),
        agent: agent.clone(),
    };
    let app = router(state, &web_root);

    let stop = shutdown.clone();
    std::thread::spawn(move || {
        drop(io::stdin().read(&mut [0]));
        stop.cancel();
    });
    writeln!(io::stdout(), "LIVENOTE_CHAT_FIXTURE_URL=http://{address}")?;
    let stopped = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown.clone().cancelled_owned())
        .await;
    shutdown.cancel();
    agent.drain().await;
    stopped.context("Ошибка тестового HTTP-сервера LiveNote")
}
