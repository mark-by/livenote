use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

use livenote_diagrams::DiagramEngine;
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio::{runtime::Handle, sync::oneshot, time::timeout};
use vault_files::VaultFiles;

use crate::{Output, Scope, Service};

const DEADLINE: Duration = Duration::from_secs(5);

struct ScanPause {
    root: PathBuf,
    reached: oneshot::Sender<()>,
    resume: mpsc::Receiver<()>,
}

static SCAN_PAUSE: Mutex<Option<ScanPause>> = Mutex::new(None);

pub(super) fn pause_before_scan(root: &Path) {
    let pause = {
        let mut slot = SCAN_PAUSE.lock().unwrap_or_else(|error| panic!("{error}"));
        slot.take_if(|pause| pause.root == root)
    };
    if let Some(pause) = pause {
        // Если тест прерван, закрытие канала освобождает поток открытия.
        if pause.reached.send(()).is_ok() {
            assert_ne!(
                pause.resume.recv_timeout(DEADLINE * 2),
                Err(mpsc::RecvTimeoutError::Timeout)
            );
        }
    }
}

async fn service(root: &Path) -> Service {
    let diagrams = DiagramEngine::new(root.join("no-browser"), root.join("no-web-assets"));
    Service::open(root, diagrams, "default".to_owned())
        .await
        .unwrap_or_else(|error| panic!("{error}"))
}

#[tokio::test]
async fn registry_reads_startup_vault_while_selected_vault_open_is_paused() {
    // Arrange: записываем заметку в первый Vault и задерживаем открытие второго.
    let startup = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let selected = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let note = "Start.md";
    let source = "Заметка первого Vault";
    fs::write(startup.path().join(note), source).unwrap_or_else(|error| panic!("{error}"));
    let service = Arc::new(service(startup.path()).await);
    let root = selected
        .path()
        .canonicalize()
        .unwrap_or_else(|error| panic!("{error}"));
    let (reached, scanning) = oneshot::channel();
    let (release, resume) = mpsc::channel();
    let pause = ScanPause {
        root: root.clone(),
        reached,
        resume,
    };
    *SCAN_PAUSE.lock().unwrap_or_else(|error| panic!("{error}")) = Some(pause);
    let opening_service = Arc::clone(&service);
    let opening = tokio::spawn(async move { opening_service.open_selected(root).await });
    timeout(DEADLINE, scanning)
        .await
        .unwrap_or_else(|error| panic!("Открытие не дошло до сканирования: {error}"))
        .unwrap_or_else(|error| panic!("{error}"));

    // Act: читаем заметку в другом потоке, чтобы таймер не завис вместе с запросом.
    let runtime = Handle::current();
    let mut reading = tokio::task::spawn_blocking(move || {
        runtime.block_on(service.call("get_document", json!({"path": note}), Scope::Mcp))
    });
    let before_release = timeout(DEADLINE, &mut reading).await;
    release.send(()).unwrap_or_else(|error| panic!("{error}"));
    opening
        .await
        .unwrap_or_else(|error| panic!("{error}"))
        .unwrap_or_else(|error| panic!("{error}"));

    // Assert: первый Vault вернул исходный текст до снятия задержки.
    let Ok(response) = before_release else {
        drop(reading.await);
        panic!("Первый Vault не ответил до снятия задержки открытия второго Vault");
    };
    let response = response
        .unwrap_or_else(|error| panic!("{error}"))
        .unwrap_or_else(|error| panic!("{error}"));
    let Output::Json(document) = response else {
        panic!("Ожидался JSON документа");
    };
    assert_eq!(document.get("source").and_then(Value::as_str), Some(source));
}

#[tokio::test]
async fn registry_reopens_selected_vault_after_writer_lock_error() {
    // Arrange: другой владелец держит блокировку записи выбранного каталога.
    let startup = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let selected = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let service = service(startup.path()).await;
    let writer = VaultFiles::open(selected.path()).unwrap_or_else(|error| panic!("{error}"));
    let root = selected.path().to_owned();
    let failed = service.open_selected(root.clone()).await;
    let error = failed
        .err()
        .unwrap_or_else(|| panic!("Ожидалась ошибка блокировки"));
    assert_eq!((error.status, error.code), (409, "vault_locked"));
    drop(writer);

    // Act: повторяем открытие после снятия блокировки записи.
    let reopened = timeout(DEADLINE, service.open_selected(root)).await;

    // Assert: повтор открывает выбранный Vault без перезапуска сервиса.
    let descriptor = reopened
        .unwrap_or_else(|error| panic!("Повторное открытие зависло: {error}"))
        .unwrap_or_else(|error| panic!("{error}"));
    let id = descriptor
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("Ожидался идентификатор Vault"));
    assert_ne!(id, service.startup_id());
    assert_eq!(
        descriptor.get("name").and_then(Value::as_str),
        selected.path().file_name().and_then(|name| name.to_str())
    );
}
