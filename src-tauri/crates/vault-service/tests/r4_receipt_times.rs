use std::{fs, os::unix::fs::MetadataExt, path::Path};

use livenote_diagrams::DiagramEngine;
use livenote_vault_service::{Output, Scope, Service};
use serde_json::{Value, json};
use tempfile::tempdir;
use vault_read::{DocumentInput, FileTimes, ParsedDocument};

const NOTE: &str = "Receipt.md";

async fn open(root: &Path) -> Service {
    let diagrams = DiagramEngine::new(root.join("no-browser"), root.join("no-web-assets"));
    Service::open(root, diagrams, "default".to_owned())
        .await
        .unwrap_or_else(|error| panic!("{error}"))
}

async fn call(service: &Service, operation: &str, args: Value) -> Value {
    let result = service
        .call(operation, args, Scope::Default)
        .await
        .unwrap_or_else(|error| panic!("{operation}: {error}"));
    let Output::Json(value) = result else {
        panic!("Ожидался JSON для {operation}");
    };
    value
}

#[tokio::test]
async fn document_write_receipt_keeps_disk_times_without_rewriting_after_reopen()
-> std::io::Result<()> {
    // Arrange: создаём заметку и читаем исходную версию.
    let root = tempdir()?;
    let note = root.path().join(NOTE);
    fs::write(&note, "before")?;
    let service = open(root.path()).await;
    let read_args = json!({"path": NOTE});
    let previous = call(&service, "get_document", read_args.clone()).await;
    let source = "after";
    let write_args = json!({
        "path": NOTE, "source": source, "request_id": "r4-write",
        "expected_revision": previous.pointer("/page/revision"),
        "expected_version": previous.get("version"),
    });

    // Act: сохраняем заметку и повторяем тот же запрос после переоткрытия.
    let first = call(&service, "write_document", write_args.clone()).await;
    let metadata = fs::metadata(&note)?;
    drop(service);
    let service = open(root.path()).await;
    let replay = call(&service, "write_document", write_args).await;
    let read = call(&service, "get_document", read_args).await;
    let after_replay = fs::metadata(&note)?;

    // Assert: все ответы содержат даты файла. Повтор не меняет inode и метаданные.
    let modified = metadata.modified()?;
    let times = FileTimes {
        created: metadata.created().ok(),
        modified,
    };
    let input = DocumentInput {
        path: NOTE,
        source,
        times,
    };
    let disk = ParsedDocument::parse(input, |_| panic!("У заметки нет вложений"))
        .unwrap_or_else(|error| panic!("{error}"));
    let disk = &disk.document().page;
    eprintln!(
        "createdAt/updatedAt: file={} {}; first={:?} {:?}; replay={:?} {:?}; read={:?} {:?}; inode={} -> {}",
        disk.created_at,
        disk.updated_at,
        first.pointer("/page/createdAt"),
        first.pointer("/page/updatedAt"),
        replay.pointer("/page/createdAt"),
        replay.pointer("/page/updatedAt"),
        read.pointer("/page/createdAt"),
        read.pointer("/page/updatedAt"),
        metadata.ino(),
        after_replay.ino(),
    );
    for response in [&first, &replay, &read] {
        for prefix in ["/page", "/page/blocks/0"] {
            for (field, expected) in [
                ("createdAt", &disk.created_at),
                ("updatedAt", &disk.updated_at),
            ] {
                assert_eq!(
                    response
                        .pointer(&format!("{prefix}/{field}"))
                        .and_then(Value::as_str),
                    Some(expected.as_str()),
                    "{prefix}/{field}"
                );
            }
        }
    }
    assert_eq!(replay, first);
    assert_eq!(metadata.ino(), after_replay.ino());
    assert_eq!(metadata.dev(), after_replay.dev());
    assert_eq!(modified, after_replay.modified()?);
    assert_eq!(
        (metadata.ctime(), metadata.ctime_nsec()),
        (after_replay.ctime(), after_replay.ctime_nsec())
    );
    assert_eq!(fs::read_to_string(note)?, source);
    Ok(())
}
