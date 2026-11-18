use std::{
    fs,
    io::{Cursor, Read},
    path::Path,
    time::Duration,
};

use livenote_diagrams::DiagramEngine;
use livenote_vault_service::{Output, Scope, Service};
use serde_json::{Value, json};
use tempfile::tempdir;

#[path = "service/writes.rs"]
mod writes;

fn field<'a>(value: &'a Value, pointer: &str) -> &'a Value {
    value
        .pointer(pointer)
        .unwrap_or_else(|| panic!("Отсутствует поле {pointer}"))
}

const EVENT_DEADLINE: Duration = Duration::from_secs(5);

async fn service(root: &Path) -> Service {
    let diagrams = DiagramEngine::new(root.join("no-browser"), root.join("no-web-assets"));
    Service::open(root, diagrams, "default".to_owned())
        .await
        .unwrap_or_else(|error| panic!("{error}"))
}

async fn call(service: &Service, operation: &str, args: Value) -> Value {
    let Output::Json(value) = service
        .call(operation, args, Scope::Default)
        .await
        .unwrap_or_else(|error| panic!("{error}"))
    else {
        panic!("Ожидался JSON для {operation}");
    };
    value
}

async fn document(service: &Service, path: &str) -> Value {
    call(service, "get_document", json!({"path":path})).await
}

#[tokio::test]
async fn exact_import_and_archive_preserve_markdown_and_binary() {
    // Arrange: каталог содержит двоичный файл и обычную заметку с BOM и CRLF.
    let root = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let service = service(root.path()).await;
    let source = "\u{feff}# Порядок\r\n\r\nбез перевода строки";
    let path = "Docs/Note.md";
    call(
        &service,
        "import_markdown",
        json!({"content":source,"path":path}),
    )
    .await;
    let binary = [0u8, 255, 127];
    fs::write(root.path().join("Docs/sample.bin"), binary)
        .unwrap_or_else(|error| panic!("{error}"));

    // Act: экспортируем хранилище в ZIP.
    let Output::Bytes(bytes) = service
        .call("export_vault", json!({}), Scope::Default)
        .await
        .unwrap_or_else(|error| panic!("{error}"))
    else {
        panic!("Ожидались байты ZIP");
    };

    // Assert: архив содержит исходные байты файлов по относительным путям.
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).unwrap_or_else(|error| panic!("{error}"));
    for (name, expected) in [
        (path, source.as_bytes()),
        ("Docs/sample.bin", binary.as_slice()),
    ] {
        let mut data = Vec::new();
        archive
            .by_name(name)
            .unwrap_or_else(|error| panic!("{error}"))
            .read_to_end(&mut data)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(data, expected);
    }
}

#[tokio::test]
async fn durable_receipt_replays_after_reopen_without_creating_another_page() {
    // Arrange: создаём страницу и открываем каталог заново.
    let root = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let args = json!({"title":"Retry","source":"exact","request_id":"one-key"});
    let first = {
        let service = service(root.path()).await;
        call(&service, "add_page", args.clone()).await
    };
    let service = service(root.path()).await;

    // Act: повторяем запрос с прежним ключом.
    let replay = call(&service, "add_page", args).await;

    // Assert: результат совпадает, второй файл не создан.
    assert_eq!(replay, first);
    assert!(!root.path().join("Retry 2.md").exists());
}

#[tokio::test]
async fn stale_document_write_cannot_replace_external_bytes() {
    // Arrange: внешний редактор меняет заметку после чтения.
    let root = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let path = "Doc.md";
    fs::write(root.path().join(path), "before").unwrap_or_else(|error| panic!("{error}"));
    let service = service(root.path()).await;
    let before = document(&service, path).await;
    fs::write(root.path().join(path), "external").unwrap_or_else(|error| panic!("{error}"));

    // Act: пишем с исходной версией.
    let error = service.call("write_document", json!({
        "path":path,"expected_revision":field(&before, "/page/revision"),"expected_version":field(&before, "/version"),"source":"stale"
    }), Scope::Default).await.err().unwrap_or_else(|| panic!("Ожидалась ошибка операции"));

    // Assert: конфликт не затронул файл.
    assert_eq!((error.status, error.code), (409, "conflict"));
    assert_eq!(
        fs::read(root.path().join(path)).unwrap_or_else(|error| panic!("{error}")),
        b"external"
    );
}

#[tokio::test]
async fn unavailable_validator_never_publishes_diagram() {
    // Arrange: запускаем сервис без Chromium.
    let root = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let path = "Doc.md";
    fs::write(root.path().join(path), "original").unwrap_or_else(|error| panic!("{error}"));
    let service = service(root.path()).await;
    let before = document(&service, path).await;

    // Act: добавляем диаграмму, для которой требуется проверка.
    let output = call(&service, "write_diagram", json!({
        "page_id":path,"expected_revision":field(&before, "/page/revision"),"source":"flowchart LR\n A --> B"
    })).await;

    // Assert: ответ указывает, что проверки не было, а исходник не меняется.
    assert_eq!(field(&output, "/validation/syntax"), "not_checked");
    assert_eq!(
        field(&output, "/revision"),
        field(&before, "/page/revision")
    );
    assert_eq!(
        fs::read(root.path().join(path)).unwrap_or_else(|error| panic!("{error}")),
        b"original"
    );
}

#[tokio::test]
async fn folder_move_preserves_empty_directories_and_rewrites_resolved_links() {
    // Arrange: ссылки ведут внутрь и наружу перемещаемой папки.
    let root = tempdir().unwrap_or_else(|error| panic!("{error}"));
    fs::create_dir_all(root.path().join("Docs/Empty")).unwrap_or_else(|error| panic!("{error}"));
    fs::write(
        root.path().join("Docs/Note.md"),
        "[outside](../Ref.md#heading)\r\n",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    fs::write(root.path().join("Ref.md"), "[[Docs/Note|label]]")
        .unwrap_or_else(|error| panic!("{error}"));
    let service = service(root.path()).await;
    let vault = call(&service, "get_vault", json!({})).await;

    // Act: перемещаем папку на уровень глубже.
    call(
        &service,
        "move_folder",
        json!({
            "from":"Docs","path":"Archive/Docs","expected_tree_version":field(&vault, "/treeVersion")
        }),
    )
    .await;

    // Assert: обе ссылки доступны, пустая папка сохранилась.
    assert_eq!(
        fs::read(root.path().join("Archive/Docs/Note.md"))
            .unwrap_or_else(|error| panic!("{error}")),
        b"[outside](../../Ref.md#heading)\r\n"
    );
    assert_eq!(
        fs::read(root.path().join("Ref.md")).unwrap_or_else(|error| panic!("{error}")),
        b"[[Archive/Docs/Note.md|label]]"
    );
    assert!(root.path().join("Archive/Docs/Empty").is_dir());
}

#[tokio::test]
async fn external_events_are_scoped_to_the_selected_vault() {
    // Arrange: два хранилища содержат файл с одним и тем же именем.
    let root = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let other = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let path = "Same.md";
    fs::write(root.path().join(path), "startup").unwrap_or_else(|error| panic!("{error}"));
    fs::write(other.path().join(path), "selected").unwrap_or_else(|error| panic!("{error}"));
    let service = service(root.path()).await;
    let descriptor = service
        .open_selected(other.path().to_owned())
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let mut selected = service
        .subscribe(Some(
            field(&descriptor, "/id")
                .as_str()
                .unwrap_or_else(|| panic!("id должен быть строкой")),
        ))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let mut startup = service
        .subscribe(None)
        .await
        .unwrap_or_else(|error| panic!("{error}"));

    // Act: внешнее приложение меняет только выбранный файл.
    fs::write(other.path().join(path), "external").unwrap_or_else(|error| panic!("{error}"));

    // Assert: событие содержит путь и признак внешнего изменения.
    let event = tokio::time::timeout(EVENT_DEADLINE, selected.recv())
        .await
        .unwrap_or_else(|error| panic!("{error}"))
        .unwrap_or_else(|| panic!("Канал событий закрыт"));
    assert_eq!(field(&event, "/event"), "page.updated");
    assert_eq!(field(&event, "/pageId"), path);
    assert_eq!(field(&event, "/origin"), "external");
    assert_eq!(
        tokio::time::timeout(Duration::ZERO, startup.recv())
            .await
            .ok()
            .flatten(),
        None
    );
}

#[tokio::test]
async fn mcp_requires_an_explicit_vault_when_two_are_open() {
    // Arrange: открываем два хранилища.
    let root = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let other = tempdir().unwrap_or_else(|error| panic!("{error}"));
    let service = service(root.path()).await;
    service
        .open_selected(other.path().to_owned())
        .await
        .unwrap_or_else(|error| panic!("{error}"));

    // Act: MCP запрашивает запись без vault_id.
    let error = service
        .call("add_page", json!({"title":"Ambiguous"}), Scope::Mcp)
        .await
        .err()
        .unwrap_or_else(|| panic!("Ожидалась ошибка операции"));

    // Assert: неоднозначная запись не затронула ни одно хранилище.
    assert_eq!((error.status, error.code), (409, "vault_required"));
    assert!(!root.path().join("Ambiguous.md").exists());
    assert!(!other.path().join("Ambiguous.md").exists());
}
