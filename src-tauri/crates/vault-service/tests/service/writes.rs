use super::{Scope, call, document, field, fs, json, service, tempdir};

#[tokio::test]
async fn retry_replays_the_typescript_receipt_before_checking_document_revision() {
    // Arrange: хранилище содержит квитанцию прежнего сервера и более новую редакцию заметки.
    let root = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let receipts = root.path().join(".livenote/requests");
    fs::create_dir_all(&receipts).unwrap_or_else(|error| panic!("{error}"));
    fs::write(root.path().join("Doc.md"), "external").unwrap_or_else(|error| panic!("{error}"));
    let key = "typescript-retry";
    let version = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    let signed = format!(
        r#"{{"operation":"write_document","pageId":"Doc.md","expectedRevision":7,"expectedVersion":"{version}","source":"written","references":[{{"path":"Link.mmd","expectedVersion":"{version}"}}]}}"#
    );
    let saved = json!({"path":"Doc.md","source":"written"});
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_else(|error| panic!("{error}"));
    let receipt = json!({"created": u64::try_from(now.as_millis()).unwrap_or(u64::MAX),
        "signature": vault_read::sha256(signed.as_bytes()), "response":saved});
    let file = receipts.join(format!("{}.json", vault_read::sha256(key.as_bytes())));
    fs::write(file, receipt.to_string()).unwrap_or_else(|error| panic!("{error}"));
    let service = service(root.path()).await;

    // Act: повторяем подписанный запрос с прежней ревизией.
    let actual = call(&service, "write_document", json!({
        "path":"Doc.md","expected_revision":7,"expected_version":version,"source":"written","request_id":key,
        "references":[{"path":"Link.mmd","expected_version":version}]
    })).await;

    // Assert: сервис вернул квитанцию и сохранил редакцию внешнего приложения.
    assert_eq!(actual, saved);
    assert_eq!(
        fs::read(root.path().join("Doc.md")).unwrap_or_else(|error| panic!("{error}")),
        b"external"
    );
}

#[tokio::test]
async fn insert_uses_utf16_offsets_and_keeps_unrelated_bytes() {
    // Arrange: между первой и второй строками есть BOM, символ вне BMP и CRLF.
    let root = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let path = "Exact.md";
    let original = "\u{feff}🏗\r\nold";
    fs::write(root.path().join(path), original).unwrap_or_else(|error| panic!("{error}"));
    let service = service(root.path()).await;
    let document = document(&service, path).await;

    // Act: позиция 5 в UTF-16 указывает на начало второй строки.
    call(
        &service,
        "write_markdown",
        json!({
            "page_id": path, "expected_revision": field(&document, "/page/revision"),
            "at": 5, "source": "inserted"
        }),
    )
    .await;

    // Assert: сервис вставил строку и сохранил исходные байты по обе стороны.
    assert_eq!(
        fs::read_to_string(root.path().join(path)).unwrap_or_else(|error| panic!("{error}")),
        "\u{feff}🏗\r\ninserted\r\nold"
    );
}

#[tokio::test]
async fn markdown_block_cannot_bypass_diagram_validation() {
    // Arrange: сервис работает без Chromium, заметка не содержит диаграмм.
    let root = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let path = "Plain.md";
    fs::write(root.path().join(path), "plain").unwrap_or_else(|error| panic!("{error}"));
    let service = service(root.path()).await;
    let document = document(&service, path).await;

    // Act: вызываем запись Markdown с новым блоком Mermaid.
    let result = service
        .call(
            "write_markdown",
            json!({
                "page_id": path, "expected_revision": field(&document, "/page/revision"),
                "source": "```mermaid\nflowchart LR\n  A --> B\n```"
            }),
            Scope::Default,
        )
        .await;

    // Assert: попытка не опубликовала диаграмму без проверки.
    assert!(matches!(result, Err(error) if error.code == "diagram_invalid"));
    assert_eq!(
        fs::read(root.path().join(path)).unwrap_or_else(|error| panic!("{error}")),
        b"plain"
    );
}

#[tokio::test]
async fn delete_page_preserves_shared_assets_and_removes_unreferenced_ones() {
    // Arrange: две заметки используют одну диаграмму, только первая использует вторую.
    let root = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let path = "First.md";
    for (name, source) in [
        (path, "![shared](Shared.drawio)\n![single](Single.drawio)"),
        ("Second.md", "![shared](Shared.drawio)"),
        ("Shared.drawio", "<mxfile/>"),
        ("Single.drawio", "<mxfile/>"),
    ] {
        fs::write(root.path().join(name), source).unwrap_or_else(|error| panic!("{error}"));
    }
    let service = service(root.path()).await;
    let document = document(&service, path).await;

    // Act: удаляем первую заметку.
    let result = service
        .call(
            "delete_page",
            json!({
                "page_id": path, "expected_revision": field(&document, "/page/revision"),
            }),
            Scope::Default,
        )
        .await;

    // Assert: удалено только вложение, которое больше не используется.
    assert!(matches!(result, Ok(super::Output::Empty)));
    assert!(!root.path().join("Single.drawio").exists());
    assert_eq!(
        fs::read(root.path().join("Shared.drawio")).unwrap_or_else(|error| panic!("{error}")),
        b"<mxfile/>"
    );
}
