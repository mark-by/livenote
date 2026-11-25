use std::{env, fs, io::Write as _, os::unix::fs::PermissionsExt, path::Path, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use flate2::{Compression, write::DeflateEncoder};
use livenote_diagrams::DiagramEngine;
use livenote_vault_service::{
    Output, Scope, Service,
    agent_documents::{
        Base, CapturedFocus, CasBytes, DiagramFormat, DocTurn, Edit, ElementKind, ElementRef,
        Layout, Lines, Overlay, Patch, Query, Target,
    },
};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::json;
use tempfile::tempdir;

#[path = "agent_documents/stage_diagram.rs"]
mod stage_diagram;

const DEADLINE: Duration = Duration::from_secs(5);

async fn service(root: &Path) -> Service {
    let engine = DiagramEngine::new(root.join("no-browser"), root.join("no-worker"));
    Service::open(root, engine, "default".into()).await.unwrap()
}

fn root_focus() -> CapturedFocus {
    CapturedFocus::Folder {
        folder: String::new(),
    }
}

async fn base(service: &Service, path: &str) -> Base {
    let result = service
        .call("get_document", json!({"path":path}), Scope::Default)
        .await
        .unwrap();
    let Output::Json(doc) = result else {
        panic!("Ожидался документ")
    };
    Base {
        revision: doc["page"]["revision"].as_u64().unwrap(),
        version: doc["version"].as_str().unwrap().to_owned(),
    }
}

async fn replace_line(turn: &mut DocTurn, path: &str, line: usize, text: &str, layout: Layout) {
    let read = turn
        .read(
            path,
            Lines {
                first: line,
                last: line,
            },
        )
        .await
        .unwrap();
    let old = read.fragment.text;
    turn.stage(Edit::Patch {
        read_id: read.read_id,
        layout,
        edits: vec![Patch {
            from: read.offset,
            to: read.offset + old.encode_utf16().count(),
            old,
            text: text.to_owned(),
        }],
    })
    .await
    .unwrap();
}

async fn stage_new(turn: &mut DocTurn, path: &str, source: &str) {
    turn.stage(Edit::Create {
        path: path.to_owned(),
        source: source.to_owned(),
    })
    .await
    .unwrap();
}

async fn capacity_vault(root: &Path) -> Result<DocTurn, Box<dyn std::error::Error>> {
    vault_with_notes(root, [
        (
            "development/archive/01-release-log.md",
            "Build cache capacity increased.\nExport capacity unchanged.\nDisk capacity alerts tuned.",
        ),
        (
            "development/archive/02-office.md",
            "Meeting room capacity: 20.\nBike rack capacity: 12.",
        ),
        (
            "development/archive/03-capacityless.md",
            "Historical capacity checklist, no current thresholds.",
        ),
        (
            "development/capacity/production/limits.md",
            "# Production limits\n\nUse 24 workers at peak.",
        ),
        (
            "development/operations/capacity-runbook.md",
            "# Worker runbook\n\nProduction capacity is 24 workers.",
        ),
        (
            "other/capacity.md",
            "Production capacity for another project is 60 workers.",
        ),
    ])
    .await
}

async fn vault_with_notes<'a>(
    root: &Path,
    notes: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Result<DocTurn, Box<dyn std::error::Error>> {
    for (path, source) in notes {
        let file = root.join(path);
        let dir = file
            .parent()
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        fs::create_dir_all(dir)?;
        fs::write(file, source)?;
    }
    let service = service(root).await;
    let vault = service.agent_vault(service.startup_id())?;
    let turn = vault
        .turn(CapturedFocus::Folder {
            folder: "development".into(),
        })
        .await?;
    Ok(turn)
}

#[tokio::test]
async fn vault_search_reserves_results_for_the_exact_topic_and_its_primary_notes()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange: похожие папки и вложенные справочники идут раньше основных заметок.
    let root = tempdir()?;
    let turn = vault_with_notes(
        root.path(),
        [
            ("development/capacity.md", "# Capacity handbook"),
            ("local/capacity-export/01.md", "Capacity export checklist."),
            ("local/capacity-export/02.md", "Capacity export logs."),
            ("local/capacity-export/03.md", "Capacity export tests."),
            ("local/capacity-lab/01.md", "Capacity simulator setup."),
            ("local/capacity-lab/02.md", "Capacity simulator metrics."),
            ("local/capacity-lab/03.md", "Capacity simulator results."),
            ("services/capacity/api/a.md", "Capacity API v1."),
            ("services/capacity/api/b.md", "Capacity API v2."),
            ("services/capacity/api/c.md", "Capacity API test fixtures."),
            ("services/capacity/a-errors.md", "Capacity error catalogue.\n\n[Alerts](b-alerts.md)\n\n[Retries](c-retries.md)"),
            ("services/capacity/b-alerts.md", "Capacity warning catalogue."),
            ("services/capacity/c-retries.md", "Capacity retry policy."),
            ("services/capacity/z-map.md", "# Capacity overview\n\n[Provenance](provenance.md)\n\n| Topics |\n| --- |\n| [[storage\\|Storage]] |\n| [[forecast\\|Forecast]] |"),
            ("services/capacity/provenance.md", "Capacity source records come from inbound events."),
            ("services/capacity/storage.md", "Capacity records are stored by warehouse."),
            ("services/capacity/forecast.md", "Capacity forecasts use the stored records."),
        ],
    )
    .await?;

    // Act: выполняем общий поиск с лимитом чата.
    let hits = turn
        .search(Query {
            text: "capacity".into(),
            limit: 5,
        })
        .await?;

    // Assert: видны руководство, обзор и три разных источника из обзора.
    let excerpts = hits
        .iter()
        .map(|hit| hit.excerpt.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        excerpts,
        [
            "# Capacity handbook",
            "# Capacity overview",
            "Capacity source records come from inbound events.",
            "Capacity records are stored by warehouse.",
            "Capacity forecasts use the stored records.",
        ],
    );
    Ok(())
}

#[tokio::test]
async fn project_search_prioritizes_topic_notes_over_incidental_mentions()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange: пять ранних совпадений заполняют выдачу до тематических заметок.
    let root = tempdir()?;
    let turn = capacity_vault(root.path()).await?;

    // Act: ищем тему в пределах проекта с лимитом чата.
    let hits = turn
        .search_project(Query {
            text: "capacity".into(),
            limit: 5,
        })
        .await?;

    // Assert: первые две цитаты ведут к тематическим заметкам, а не к журналу.
    let mut top = hits
        .iter()
        .take(2)
        .map(|hit| (hit.cite.path.as_str(), hit.cite.line, hit.excerpt.as_str()))
        .collect::<Vec<_>>();
    top.sort_unstable();
    assert_eq!(
        top,
        [
            (
                "development/capacity/production/limits.md",
                1,
                "# Production limits"
            ),
            (
                "development/operations/capacity-runbook.md",
                3,
                "Production capacity is 24 workers."
            ),
        ],
    );
    assert_eq!(hits.len(), 5);
    Ok(())
}

#[tokio::test]
async fn project_search_returns_only_matching_lines_for_multiword_queries()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange: общий проект содержит тематические и случайные совпадения.
    let root = tempdir()?;
    let turn = capacity_vault(root.path()).await?;

    for (text, expected) in [
        (
            "production capacity",
            Some("Production capacity is 24 workers."),
        ),
        ("What is the production capacity?", None),
        ("какие пределы у capacity?", None),
        ("quadrature", None),
    ] {
        // Act: передаём буквальный запрос или полный вопрос.
        let hits = turn
            .search_project(Query {
                text: text.into(),
                limit: 5,
            })
            .await?;

        // Assert: совпадение другого проекта и отдельное слово из вопроса не подходят.
        let excerpts = hits
            .iter()
            .map(|hit| hit.excerpt.as_str())
            .collect::<Vec<_>>();
        assert_eq!(excerpts, expected.into_iter().collect::<Vec<_>>(), "{text}");
    }
    Ok(())
}

#[tokio::test]
async fn commit_publishes_group_bytes_and_events_and_cleans_journal() {
    // Arrange: заметка с CRLF и символом вне BMP перед правкой.
    let root = tempdir().unwrap();
    fs::write(root.path().join("Doc.md"), "🏗\r\nдо").unwrap();
    fs::create_dir(root.path().join("Docs")).unwrap();
    let created = "Docs/New.md";
    let service = service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut events = service.subscribe(Some(vault.id())).await.unwrap();
    let mut turn = vault.turn(root_focus()).await.unwrap();
    let read = turn
        .read("Doc.md", Lines { first: 2, last: 2 })
        .await
        .unwrap();
    assert_eq!((read.offset, read.fragment.text.as_str()), (4, "до"));

    // Act: готовим две записи и публикуем их одним вызовом.
    turn.stage(Edit::Patch {
        read_id: read.read_id,
        edits: vec![Patch {
            from: 4,
            to: 6,
            old: "до".into(),
            text: "после".into(),
        }],
        layout: Layout::Preserve,
    })
    .await
    .unwrap();
    stage_new(&mut turn, created, "новое").await;
    let hit = turn
        .search(Query {
            text: "после".into(),
            limit: 5,
        })
        .await
        .unwrap();
    assert_eq!((hit[0].cite.path.as_str(), hit[0].cite.line), ("Doc.md", 2));
    assert_eq!(
        fs::read_to_string(root.path().join("Doc.md")).unwrap(),
        "🏗\r\nдо"
    );
    assert!(!root.path().join(created).exists());
    assert_eq!(turn.commit().await.unwrap(), ["Doc.md", created]);

    // Assert: обе записи опубликованы, события отправлены, временный журнал удалён.
    for (name, path) in [("page.updated", "Doc.md"), ("page.created", created)] {
        let event = tokio::time::timeout(DEADLINE, events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["event"], name);
        assert_eq!(event["pageId"], path);
        assert_eq!(event["origin"], "agent");
    }
    assert_eq!(
        fs::read_to_string(root.path().join("Doc.md")).unwrap(),
        "🏗\r\nпосле"
    );
    assert_eq!(
        fs::read_to_string(root.path().join(created)).unwrap(),
        "новое"
    );
    let metadata = root.path().join(".livenote");
    assert_eq!(
        fs::read_dir(metadata.join("transactions")).unwrap().count(),
        0
    );
    assert!(!fs::read_dir(metadata).unwrap().any(|entry| {
        let entry = entry.unwrap();
        entry
            .file_name()
            .as_encoded_bytes()
            .starts_with(b".finished-")
    }));
}

#[tokio::test]
async fn bindings_compare_expected_bytes_version_in_selected_vault() {
    // Arrange: два открытых хранилища без привязок.
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let service = service(first.path()).await;
    let descriptor = service
        .open_selected(second.path().to_path_buf())
        .await
        .unwrap();
    let vault = service
        .agent_vault(descriptor["id"].as_str().unwrap())
        .unwrap();
    let startup = service.agent_vault(service.startup_id()).unwrap();

    // Act: записываем привязки дважды с версией отсутствующего файла.
    let bytes = br#"{"schema":1,"folders":{}}"#.to_vec();
    let version = vault
        .write_bindings(CasBytes {
            expected_version: None,
            bytes: bytes.clone(),
        })
        .await
        .unwrap();
    let error = vault
        .write_bindings(CasBytes {
            expected_version: None,
            bytes: b"other".to_vec(),
        })
        .await
        .unwrap_err();

    // Assert: в первом vault файла нет, а конфликт не меняет второй файл.
    assert_eq!(error.status, 409);
    assert_eq!(error.data.unwrap()["paths"][0], "livenote.bindings.json");
    assert!(startup.read_bindings().await.unwrap().is_none());
    let result = vault.read_bindings().await.unwrap().unwrap();
    assert_eq!((result.version, result.bytes), (version, bytes));
}

#[tokio::test]
async fn draft_is_local_until_the_agent_edits_it() {
    // Arrange: редактор передаёт черновик заметки с неизменённой схемой.
    let root = tempdir().unwrap();
    let path = "Doc.md";
    let fence = "```mermaid\nflowchart LR\nA --> B\n```";
    let disk = format!("диск\n\n{fence}");
    let draft = format!("черновик\n\n{fence}");
    fs::write(root.path().join(path), &disk).unwrap();
    let service = service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let base = base(&service, path).await;
    let from = "черновик\n\n".encode_utf16().count();
    let focus = CapturedFocus::Diagram {
        path: path.to_owned(),
        base: base.clone(),
        format: DiagramFormat::Mermaid,
        target: Target::Inline {
            from,
            to: from + fence.len(),
        },
        selected: Vec::new(),
        overlay: Some(Overlay {
            expected_revision: base.revision,
            expected_version: base.version,
            source: draft.clone(),
            assets: Vec::new(),
            references: Vec::new(),
        }),
    };

    // Act: сначала меняем другой файл, затем редактируем черновик.
    let mut other = vault.turn(focus.clone()).await.unwrap();
    let read = other.read(path, Lines { first: 1, last: 1 }).await.unwrap();
    assert_eq!(read.fragment.text, "черновик");
    stage_new(&mut other, "Other.md", "другой документ").await;
    assert_eq!(other.commit().await.unwrap(), ["Other.md"]);
    assert_eq!(fs::read_to_string(root.path().join(path)).unwrap(), disk);
    let mut turn = vault.turn(focus).await.unwrap();
    replace_line(&mut turn, path, 1, "правка агента", Layout::Preserve).await;
    assert_eq!(turn.commit().await.unwrap(), [path]);

    // Assert: правка черновика сохраняет схему, а другой файл остаётся на месте.
    assert_eq!(
        fs::read_to_string(root.path().join(path)).unwrap(),
        format!("правка агента\n\n{fence}")
    );
    assert!(root.path().join("Other.md").is_file());
}

#[tokio::test]
async fn shared_asset_conflict_keeps_all_staged_files_off_disk() {
    // Arrange: две заметки используют одну схему, захваченную при чтении.
    let root = tempdir().unwrap();
    let note = "исходник\n\n![схема](Shared.mmd)";
    for path in ["One.md", "Two.md"] {
        fs::write(root.path().join(path), note).unwrap();
    }
    fs::write(root.path().join("Shared.mmd"), "flowchart LR\nA --> B").unwrap();
    let service = service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut turn = vault.turn(root_focus()).await.unwrap();
    replace_line(&mut turn, "One.md", 1, "правка", Layout::Preserve).await;
    stage_new(&mut turn, "New.md", "новое").await;

    // Act: внешний процесс меняет общее вложение перед публикацией.
    fs::write(root.path().join("Shared.mmd"), "flowchart LR\nA --> C").unwrap();
    let error = turn.commit().await.unwrap_err();

    // Assert: конфликт указывает вложение, ни одна правка не опубликована.
    assert_eq!(error.code, "conflict");
    assert_eq!(
        error.data.unwrap()["paths"],
        json!(["One.md", "Shared.mmd"])
    );
    assert_eq!(
        fs::read_to_string(root.path().join("One.md")).unwrap(),
        note
    );
    assert!(!root.path().join("New.md").exists());
}

#[tokio::test]
async fn reading_drawio_expands_only_selected_page() {
    // Arrange: обе страницы сжаты, фокус указывает вторую.
    let root = tempdir().unwrap();
    let first = compressed_page("первая");
    let second = compressed_page("вторая");
    let source = format!(
        "<mxfile><diagram id=\"one\">{first}</diagram><diagram id=\"two\">{second}</diagram></mxfile>"
    );
    let path = "Diagram.drawio";
    fs::write(root.path().join(path), &source).unwrap();
    let service = service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut turn = vault
        .turn(CapturedFocus::Diagram {
            path: path.to_owned(),
            base: base(&service, path).await,
            format: DiagramFormat::Drawio,
            target: Target::File,
            selected: vec![ElementRef {
                id: "2".into(),
                kind: ElementKind::Element,
                page_id: Some("two".into()),
            }],
            overlay: None,
        })
        .await
        .unwrap();

    // Act: читаем исходник, к которому применяются смещения правки.
    let read = turn.read(path, Lines { first: 1, last: 1 }).await.unwrap();

    // Assert: первая страница сохранила кодировку; чтение не изменило файл.
    assert_eq!(
        read.fragment.text,
        source.replace(&second, &graph("вторая"))
    );
    assert_eq!(fs::read_to_string(root.path().join(path)).unwrap(), source);
}

fn graph(label: &str) -> String {
    format!(
        r#"<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="{label}" parent="1" vertex="1"><mxGeometry x="10" y="20" width="50" height="40" as="geometry"/></mxCell></root></mxGraphModel>"#
    )
}

fn compressed_page(label: &str) -> String {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    let graph = graph(label);
    encoder
        .write_all(
            utf8_percent_encode(&graph, NON_ALPHANUMERIC)
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    STANDARD.encode(encoder.finish().unwrap())
}

fn browser() -> (std::path::PathBuf, std::path::PathBuf) {
    (
        env::var_os("LIVENOTE_TEST_CHROMIUM").unwrap().into(),
        env::var_os("LIVENOTE_TEST_DIAGRAM_WEB").unwrap().into(),
    )
}

async fn browser_service(root: &Path) -> Service {
    let (chrome, web) = browser();
    let engine = DiagramEngine::new(chrome, web);
    Service::open(root, engine, "default".into()).await.unwrap()
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn external_write_during_diagram_validation_conflicts_before_publication() {
    // Arrange: локальный скрипт задерживает запуск реального Chromium до записи во вложение.
    let root = tempdir().unwrap();
    let fixture = tempdir().unwrap();
    let launcher = fixture.path().join("launch");
    let (chrome, web) = browser();
    fs::write(
        launcher.with_extension("browser"),
        chrome.as_os_str().as_encoded_bytes(),
    )
    .unwrap();
    fs::write(
        &launcher,
        r#"#!/bin/sh
touch "$0.started"
while [ ! -f "$0.resume" ]; do sleep 0.02; done
exec "$(cat "$0.browser")" "$@"
"#,
    )
    .unwrap();
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
    let asset = "Shared.drawio";
    let note = "до\n\n![схема](Shared.drawio)";
    fs::write(root.path().join(asset), graph("общая")).unwrap();
    fs::write(root.path().join("Doc.md"), note).unwrap();
    let service = Service::open(
        root.path(),
        DiagramEngine::new(launcher.clone(), web),
        "default".into(),
    )
    .await
    .unwrap();
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut turn = vault.turn(root_focus()).await.unwrap();
    replace_line(&mut turn, "Doc.md", 1, "после", Layout::Preserve).await;
    stage_new(&mut turn, "Valid.drawio", &graph("новая")).await;

    // Act: валидация началась; меняем зависимость, затем даём браузеру завершить проверку.
    let pending = tokio::spawn(turn.commit());
    tokio::time::timeout(DEADLINE, async {
        while !launcher.with_extension("started").is_file() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    fs::write(root.path().join(asset), graph("ручная правка")).unwrap();
    fs::write(launcher.with_extension("resume"), "").unwrap();
    let error = pending.await.unwrap().unwrap_err();

    // Assert: успешная проверка схемы не разрешила запись со старой версией вложения.
    assert_eq!(error.code, "conflict", "{error}");
    assert_eq!(error.data.unwrap()["paths"], json!(["Doc.md", asset]));
    assert_eq!(
        fs::read_to_string(root.path().join("Doc.md")).unwrap(),
        note
    );
    assert!(!root.path().join("Valid.drawio").exists());
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn drawio_label_edit_preserves_other_page_and_notifies_shared_owners() {
    // Arrange: две заметки ссылаются на файл с двумя сжатыми страницами.
    let root = tempdir().unwrap();
    let first = compressed_page("первая");
    let second = compressed_page("вторая");
    let path = "Shared.drawio";
    let source = format!(
        "<mxfile><diagram id=\"one\">{first}</diagram><diagram id=\"two\">{second}</diagram></mxfile>"
    );
    fs::write(root.path().join(path), &source).unwrap();
    let note = "![схема](Shared.drawio)";
    for owner in ["One.md", "Two.md"] {
        fs::write(root.path().join(owner), note).unwrap();
    }
    let service = browser_service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut events = service.subscribe(Some(vault.id())).await.unwrap();
    let mut turn = vault
        .turn(CapturedFocus::Diagram {
            path: "One.md".into(),
            base: base(&service, "One.md").await,
            format: DiagramFormat::Drawio,
            target: Target::Asset { path: path.into() },
            selected: vec![ElementRef {
                id: "2".into(),
                kind: ElementKind::Element,
                page_id: Some("two".into()),
            }],
            overlay: None,
        })
        .await
        .unwrap();

    // Act: агент меняет подпись на второй странице.
    let next = source.replace(&second, &graph("новая подпись"));
    replace_line(&mut turn, path, 1, &next, Layout::Preserve).await;
    let paths = turn.commit().await.unwrap();

    // Assert: обе заметки получили SSE; первая страница сохранила сжатые байты.
    assert_eq!(paths, ["One.md", path, "Two.md"]);
    for path in paths {
        let event = tokio::time::timeout(DEADLINE, events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["event"], "page.updated");
        assert_eq!(event["pageId"], path);
    }
    assert_eq!(fs::read_to_string(root.path().join(path)).unwrap(), next);
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn mermaid_accepts_coordinate_preserving_edit_but_rejects_relayout() {
    // Arrange: направленная блок-схема в отдельном файле.
    let root = tempdir().unwrap();
    let path = "Flow.mmd";
    let source = "flowchart LR\n A --> B";
    fs::write(root.path().join(path), source).unwrap();
    let service = browser_service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();

    // Act: добавляем комментарий без влияния на геометрию, затем меняем направление.
    let mut turn = vault.turn(root_focus()).await.unwrap();
    let first_line = "flowchart LR\n%% описание";
    replace_line(&mut turn, path, 1, first_line, Layout::Preserve).await;
    turn.commit().await.unwrap();
    let mut turn = vault.turn(root_focus()).await.unwrap();
    replace_line(&mut turn, path, 1, "flowchart TB", Layout::Preserve).await;
    let error = turn.commit().await.unwrap_err();

    // Assert: опубликован только комментарий; смена направления вернула ошибку схемы.
    assert_eq!(error.code, "diagram_invalid");
    assert_eq!(
        fs::read_to_string(root.path().join(path)).unwrap(),
        format!("{first_line}\n A --> B")
    );
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn new_bpmn_auto_layout_publishes_di_after_validating_group() {
    // Arrange: новый BPMN без BPMNDI и заметка, которая на него ссылается.
    let root = tempdir().unwrap();
    let service = browser_service(root.path()).await;
    let vault = service.agent_vault(service.startup_id()).unwrap();
    let mut turn = vault.turn(root_focus()).await.unwrap();
    let path = "Process.bpmn";
    let xml = r#"<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="urn:test"><bpmn:process id="Process"><bpmn:startEvent id="Start"/></bpmn:process></bpmn:definitions>"#;
    stage_new(&mut turn, path, xml).await;
    stage_new(&mut turn, "Process.md", "![процесс](Process.bpmn)").await;

    // Act: запрашиваем автораскладку нового файла.
    replace_line(&mut turn, path, 1, xml, Layout::Auto).await;
    assert_eq!(turn.commit().await.unwrap(), [path, "Process.md"]);
    let written = fs::read_to_string(root.path().join(path)).unwrap();

    // Assert: журнал опубликовал XML с геометрией и заметку из того же плана.
    assert!(written.contains("BPMNShape"));
    assert!(written.contains("Bounds"));
    assert!(root.path().join("Process.md").is_file());
}
