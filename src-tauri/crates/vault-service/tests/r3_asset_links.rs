use std::{fs, path::Path};

use livenote_diagrams::DiagramEngine;
use livenote_vault_service::{Output, Scope, Service};
use serde_json::{Value, json};
use tempfile::tempdir;

const NOTE: &str = "Owner.md";
const DIAGRAM: &str = "Flow Chart.drawio";
const DIAGRAM_SOURCE: &str = "<mxfile/>";
const EMBED: &str = "![Диаграмма](Flow%20Chart.drawio)";
const LINK: &str = "[Диаграмма](Flow%20Chart.drawio)";

async fn open(root: &Path) -> Service {
    let diagrams = DiagramEngine::new(root.join("no-browser"), root.join("no-web-assets"));
    Service::open(root, diagrams, "default".to_owned())
        .await
        .unwrap_or_else(|error| panic!("{error}"))
}

async fn call(service: &Service, operation: &str, args: Value) -> Output {
    service
        .call(operation, args, Scope::Default)
        .await
        .unwrap_or_else(|error| panic!("{operation}: {error}"))
}

async fn document(service: &Service, path: &str) -> Value {
    let Output::Json(value) = call(service, "get_document", json!({"path": path})).await else {
        panic!("get_document не вернул JSON для {path}");
    };
    value
}

async fn assert_link_survives(service: &Service, root: &Path, note: &str) {
    let doc = document(service, note).await;
    let target = doc.pointer("/links/0/targetPageId").and_then(Value::as_str);
    let file = fs::read_to_string(root.join(DIAGRAM));
    eprintln!("{note}: targetPageId={target:?}, файл={file:?}");
    assert_eq!(target, Some(DIAGRAM));
    assert_eq!(
        file.unwrap_or_else(|error| panic!("{DIAGRAM}: {error}")),
        DIAGRAM_SOURCE
    );
}

#[tokio::test]
async fn delete_page_keeps_diagram_linked_from_another_note() -> Result<(), std::io::Error> {
    // Arrange: вторая заметка ссылается на диаграмму обычной относительной ссылкой.
    let root = tempdir()?;
    let other = "notes/Reader.md";
    let unused = "Orphan.drawio";
    fs::create_dir(root.path().join("notes"))?;
    fs::write(
        root.path().join(NOTE),
        format!("{EMBED}\n\n![Лишняя]({unused})"),
    )?;
    fs::write(
        root.path().join(other),
        "[Диаграмма](../Flow%20Chart.drawio)",
    )?;
    fs::write(root.path().join(DIAGRAM), DIAGRAM_SOURCE)?;
    fs::write(root.path().join(unused), DIAGRAM_SOURCE)?;
    let service = open(root.path()).await;
    let owner = document(&service, NOTE).await;

    // Act: удаляем заметку с двумя встроенными диаграммами.
    let args = json!({"page_id": NOTE, "expected_revision": owner.pointer("/page/revision")});
    let result = call(&service, "delete_page", args).await;

    // Assert: заметка и диаграмма без ссылок удалены. Обычная ссылка по-прежнему ведёт к файлу.
    assert!(matches!(result, Output::Empty));
    assert!(!root.path().join(NOTE).try_exists()?);
    assert!(!root.path().join(unused).try_exists()?);
    assert_link_survives(&service, root.path(), other).await;
    Ok(())
}

#[tokio::test]
async fn write_document_keeps_diagram_when_embed_becomes_link() -> Result<(), std::io::Error> {
    // Arrange: заметка содержит встроенную диаграмму.
    let root = tempdir()?;
    fs::write(root.path().join(NOTE), EMBED)?;
    fs::write(root.path().join(DIAGRAM), DIAGRAM_SOURCE)?;
    let service = open(root.path()).await;
    let owner = document(&service, NOTE).await;

    // Act: сохраняем новую редакцию с обычной ссылкой вместо вложения.
    let args = json!({
        "path": NOTE, "expected_revision": owner.pointer("/page/revision"),
        "expected_version": owner.get("version"), "source": LINK
    });
    call(&service, "write_document", args).await;

    // Assert: файл сохранился, а новая ссылка ведёт к нему.
    assert_eq!(fs::read_to_string(root.path().join(NOTE))?, LINK);
    assert_link_survives(&service, root.path(), NOTE).await;
    Ok(())
}

#[tokio::test]
async fn delete_block_keeps_diagram_linked_in_remaining_source() -> Result<(), std::io::Error> {
    // Arrange: заметка содержит вложение и отдельную обычную ссылку на тот же файл.
    let root = tempdir()?;
    fs::write(root.path().join(NOTE), format!("{EMBED}\n\n{LINK}"))?;
    fs::write(root.path().join(DIAGRAM), DIAGRAM_SOURCE)?;
    let service = open(root.path()).await;
    let owner = document(&service, NOTE).await;

    // Act: удаляем блок со встроенной диаграммой.
    let args = json!({
        "page_id": NOTE, "expected_revision": owner.pointer("/page/revision"),
        "block_id": owner.pointer("/page/blocks/0/id")
    });
    call(&service, "delete_block", args).await;

    // Assert: на диске осталась обычная ссылка, и сервис разрешает её в сохранённый файл.
    assert_eq!(fs::read_to_string(root.path().join(NOTE))?.trim(), LINK);
    assert_link_survives(&service, root.path(), NOTE).await;
    Ok(())
}
