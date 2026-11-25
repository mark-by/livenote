use super::{
    base, browser_service, fs, graph, json, replace_line, root_focus, service, stage_new, tempdir,
};
use livenote_vault_service::{
    Output, Scope, Service,
    agent_documents::{DiagramFormat, Layout, Lines, StageDiagram},
};

const FLOW: &str = "flowchart LR\n  A --> B";
const BPMN: &str = r#"<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="urn:test"><bpmn:process id="Process"><bpmn:startEvent id="Start"/></bpmn:process></bpmn:definitions>"#;

fn diagram(page_path: &str, format: DiagramFormat, source: &str) -> StageDiagram {
    StageDiagram {
        page_path: page_path.into(),
        format,
        source: source.into(),
        title: Some("Согласование".into()),
    }
}

async fn assert_renders(service: &Service, page: &str, block: &serde_json::Value) {
    let args = json!({"page_id": page, "block_id": block["id"], "mode": "render"});
    let Output::Json(render) = service
        .call("check_diagram", args, Scope::Default)
        .await
        .unwrap()
    else {
        panic!("Ожидался результат рендера")
    };
    assert_eq!(render["validation"]["syntax"], "ok", "{render}");
    let svg = render["render"]["svg"].as_str().unwrap();
    assert!(svg.contains("<svg"), "{svg}");
}

#[tokio::test]
async fn unavailable_validation_leaves_the_draft_unchanged_and_blocks_commit() {
    // Arrange: агент подготовил новую страницу, но Chromium недоступен.
    let root = tempdir().unwrap();
    let service = service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut turn = vault.turn(root_focus()).await.unwrap();
    let path = "Process.md";
    stage_new(&mut turn, path, "Черновик").await;

    // Act: агент добавляет BPMN и завершает сообщение без успешного повтора.
    let error = turn
        .stage_diagram(diagram(path, DiagramFormat::Bpmn, BPMN))
        .await
        .unwrap_err();
    let draft = turn.read(path, Lines { first: 1, last: 20 }).await.unwrap();
    let commit = turn.commit().await.unwrap_err();

    // Assert: снимок остался прежним, страница и вложение не появились.
    assert_eq!((error.status, error.code), (422, "diagram_invalid"));
    assert_eq!(error.data.unwrap()["validation"]["syntax"], "not_checked");
    assert_eq!(draft.fragment.text, "Черновик");
    assert_eq!(commit.code, "diagram_invalid");
    assert!(!root.path().join(path).exists());
    assert!(!root.path().join("Схемы").exists());
}

#[tokio::test]
async fn staging_rejects_unsafe_paths_empty_sources_and_oversized_pages() {
    // Arrange: записываем заметку, которая уже достигла лимита размера.
    let root = tempdir().unwrap();
    let limit = 2 * 1024 * 1024;
    let oversized_page = "Full.md";
    fs::write(root.path().join(oversized_page), "x".repeat(limit)).unwrap();
    let service = service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut turn = vault.turn(root_focus()).await.unwrap();
    stage_new(&mut turn, "New.md", "Черновик").await;

    // Act / Assert: каждый некорректный запрос отклонён до проверки Chromium.
    for (path, source, code) in [
        ("../New.md", FLOW, "unsafe_path"),
        ("New.md", " \r\n\t", "invalid_request"),
        ("New.md", &"x".repeat(limit + 1), "invalid_request"),
        (oversized_page, FLOW, "invalid_request"),
    ] {
        let error = turn
            .stage_diagram(diagram(path, DiagramFormat::Mermaid, source))
            .await
            .unwrap_err();
        assert_eq!((error.status, error.code), (400, code), "{path}: {error}");
    }
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn a_successful_mermaid_retry_preserves_raw_snippets() {
    // Arrange: существующая заметка содержит пример BPMN, а не диаграмму.
    let root = tempdir().unwrap();
    let path = "Existing.md";
    let original = "Пример\r\n\r\n```bpmn\r\nне XML\r\n```";
    fs::write(root.path().join(path), original).unwrap();
    let service = browser_service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut turn = vault.turn(root_focus()).await.unwrap();
    let before = base(&service, path).await;

    // Act: повторяем ошибочную операцию с исправленным исходником и сохраняем.
    let error = turn
        .stage_diagram(diagram(path, DiagramFormat::Mermaid, "not a diagram"))
        .await
        .unwrap_err();
    assert_eq!(error.data.unwrap()["validation"]["syntax"], "error");
    let input =
        serde_json::from_value(json!({"pagePath": path, "format": "mermaid", "source": FLOW}))
            .unwrap();
    let staged = turn.stage_diagram(input).await.unwrap();
    assert_eq!(staged.page_path, path);
    assert_eq!(staged.asset_path, None);
    assert_eq!(base(&service, path).await.version, before.version);
    assert_eq!(turn.commit().await.unwrap(), [path]);

    // Assert: проекция содержит новый блок. Пример BPMN сохранил исходные байты.
    let Output::Json(document) = service
        .call("get_document", json!({"path": path}), Scope::Default)
        .await
        .unwrap()
    else {
        panic!("Ожидался документ")
    };
    assert_eq!(document["page"]["blocks"][1]["type"], "mermaid");
    assert_renders(&service, path, &document["page"]["blocks"][1]).await;
    assert_eq!(
        fs::read_to_string(root.path().join(path)).unwrap(),
        format!("{original}\r\n\r\n```mermaid\r\nflowchart LR\r\n  A --> B\r\n```\r\n")
    );
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn new_page_and_managed_diagrams_commit_together() {
    // Arrange: новая заметка без каталога схем и исходник BPMN без геометрии.
    let root = tempdir().unwrap();
    let service = browser_service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut turn = vault.turn(root_focus()).await.unwrap();
    fs::create_dir(root.path().join("Docs")).unwrap();
    let page = "Docs/Process.md";
    stage_new(&mut turn, page, "# Процесс").await;

    // Act: добавляем BPMN и две draw.io с одинаковыми названиями.
    let bpmn = turn
        .stage_diagram(diagram(page, DiagramFormat::Bpmn, BPMN))
        .await
        .unwrap();
    let drawio = turn
        .stage_diagram(diagram(page, DiagramFormat::Drawio, &graph("Первая")))
        .await
        .unwrap();
    let second = turn
        .stage_diagram(diagram(page, DiagramFormat::Drawio, &graph("Вторая")))
        .await
        .unwrap();
    let bpmn = bpmn.asset_path.unwrap();
    let drawio = drawio.asset_path.unwrap();
    let second = second.asset_path.unwrap();
    assert_eq!(bpmn, "Docs/Схемы/Process — Согласование.bpmn");
    assert_eq!(drawio, "Docs/Схемы/Process — Согласование.drawio");
    assert_eq!(second, "Docs/Схемы/Process — Согласование 2.drawio");
    assert!(!root.path().join(page).exists());
    assert!(!root.path().join("Docs/Схемы").exists());

    let mut paths = vec![
        page.to_owned(),
        bpmn.clone(),
        drawio.clone(),
        second.clone(),
    ];
    paths.sort();
    assert_eq!(turn.commit().await.unwrap(), paths);

    // Assert: опубликованная страница ссылается на все вложения, BPMN получил геометрию.
    let Output::Json(document) = service
        .call("get_document", json!({"path": page}), Scope::Default)
        .await
        .unwrap()
    else {
        panic!("Ожидался документ")
    };
    let assets = document["assets"].as_array().unwrap();
    let mut embedded = assets
        .iter()
        .map(|asset| asset["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    embedded.sort_unstable();
    assert_eq!(
        embedded,
        paths.iter().skip(1).map(String::as_str).collect::<Vec<_>>()
    );
    let blocks = document["page"]["blocks"].as_array().unwrap();
    for block in blocks.iter().filter(|block| block["type"] != "markdown") {
        assert_renders(&service, page, block).await;
    }
    let xml = fs::read_to_string(root.path().join(&bpmn)).unwrap();
    assert!(xml.contains("BPMNShape") && xml.contains("Bounds"));
    assert_eq!(
        fs::read_to_string(root.path().join(&drawio)).unwrap(),
        graph("Первая")
    );
    assert_eq!(
        fs::read_to_string(root.path().join(&second)).unwrap(),
        graph("Вторая")
    );
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn commit_rejects_a_managed_asset_if_a_later_patch_removes_its_embed() {
    // Arrange: агент добавил схему в новую заметку.
    let root = tempdir().unwrap();
    let service = browser_service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut turn = vault.turn(root_focus()).await.unwrap();
    let page = "Process.md";
    stage_new(&mut turn, page, "Процесс").await;
    let staged = turn
        .stage_diagram(diagram(page, DiagramFormat::Bpmn, BPMN))
        .await
        .unwrap();
    let asset = staged.asset_path.unwrap();

    // Act: новая правка удаляет встраивание до публикации.
    replace_line(&mut turn, page, 3, "Без схемы", Layout::Preserve).await;
    let error = turn.commit().await.unwrap_err();

    // Assert: ни страница, ни отдельный файл схемы не появились.
    assert_eq!(error.code, "diagram_invalid");
    assert!(!root.path().join(page).exists());
    assert!(!root.path().join(asset).exists());
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn commit_rejects_a_symlink_substituted_for_the_new_asset_directory() {
    // Arrange: агент добавил BPMN в заметку, каталог вложений пока не существует.
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let service = browser_service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut turn = vault.turn(root_focus()).await.unwrap();
    let page = "Process.md";
    stage_new(&mut turn, page, "Процесс").await;
    turn.stage_diagram(diagram(page, DiagramFormat::Bpmn, BPMN))
        .await
        .unwrap();

    // Act: внешний процесс создаёт символическую ссылку вместо каталога.
    std::os::unix::fs::symlink(outside.path(), root.path().join("Схемы")).unwrap();
    let error = turn.commit().await.unwrap_err();

    // Assert: конфликт не опубликовал заметку и не записал файл за пределами хранилища.
    assert_eq!(error.code, "conflict");
    assert!(!root.path().join(page).exists());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}
