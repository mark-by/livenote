use std::{env, fs, io, net::TcpListener, path::PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use livenote_diagrams::{
    DiagramEngine, DiagramFormat, DiagramValidation, MermaidTheme, RendererKind, ValidationStatus,
};

const DRAWIO_PAGE: &str = "jZBNDoIwEIVP8/bDEA1uAWHlIZowoSTFkloVbm9si4QFiZvJvG/y5g95Nc6tU5O+2U4M8ivyylnrYzbOlRgDpqFDXoOZwAxuDqpZqNKknNz9PwaOhpcyT4kENeHSoM5Q0DcvixADL0+BryZxXubDwQGlqa3YUbxbwLQa4l607OV76LxOKK1OWoZep6bnxNQj6v7XeDsS3KQ7V7n9M9R27/4A";
const BPMN: &str = r#"<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="urn:test">
  <bpmn:process id="Process_1">
    <bpmn:startEvent id="Start_1" />
  </bpmn:process>
</bpmn:definitions>"#;
const PNG_HEADER: &[u8] = b"\x89PNG\r\n\x1a\n";

fn chrome() -> PathBuf {
    let Some(path) = env::var_os("LIVENOTE_TEST_CHROMIUM") else {
        panic!("Укажите путь к Chrome Headless Shell");
    };
    PathBuf::from(path)
}

fn engine() -> DiagramEngine {
    let Some(web) = env::var_os("LIVENOTE_TEST_DIAGRAM_WEB") else {
        panic!("Укажите путь к сборке Vite desktop");
    };
    DiagramEngine::new(chrome(), PathBuf::from(web))
}

#[tokio::test]
async fn unavailable_chromium_does_not_validate_source() -> io::Result<()> {
    // Arrange: ресурсы есть, исполняемый файл Chromium отсутствует.
    let missing = tempfile::tempdir()?;
    fs::create_dir(missing.path().join("drawio"))?;
    fs::write(missing.path().join("drawio/index.html"), "")?;
    fs::write(missing.path().join("diagram-worker.html"), "")?;
    let engine = DiagramEngine::new(
        missing.path().join("chromium"),
        missing.path().to_path_buf(),
    );

    // Act: проверяем синтаксически корректную диаграмму.
    let validation = engine
        .validate(
            DiagramFormat::Mermaid,
            "flowchart LR\n A --> B",
            MermaidTheme::Default,
        )
        .await;

    // Assert: отсутствие браузера не даёт успешную проверку.
    assert_eq!(validation.syntax, ValidationStatus::NotChecked);
    assert_eq!(validation.renderer, RendererKind::Unavailable);
    Ok(())
}

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn mermaid_renders_theme_and_png() -> TestResult {
    // Arrange: загружаем собранный обработчик.
    let engine = engine();
    engine.warm_up().await?;

    // Act: запрашиваем рисунок с темой Redux Dark Color.
    let result = engine
        .render(
            DiagramFormat::Mermaid,
            "flowchart LR\n A[Проверка] --> B",
            MermaidTheme::ReduxDarkColor,
            true,
        )
        .await;

    // Assert: Chromium возвращает схему с подписью и PNG.
    assert_eq!(result.validation.syntax, ValidationStatus::Ok, "{result:?}");
    assert_eq!(
        result.validation.diagram_type.as_deref(),
        Some("flowchart-v2")
    );
    let render = result.render.ok_or("Нет SVG Mermaid")?;
    assert!(render.svg.contains("Проверка"));
    let png = STANDARD.decode(render.png_base64.ok_or("Нет PNG Mermaid")?)?;
    assert!(png.starts_with(PNG_HEADER));
    Ok(())
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn malformed_diagrams_report_a_syntax_error() {
    // Arrange: по одному примеру ошибок XML, Mermaid, DTD и сжатия.
    let engine = engine();
    for (format, source) in [
        (DiagramFormat::Mermaid, "flowchart LR\n A --> ["),
        (DiagramFormat::Bpmn, "<bpmn:definitions><"),
        (
            DiagramFormat::Drawio,
            "<mxfile><diagram><mxGraphModel></diagram></mxfile>",
        ),
        (
            DiagramFormat::Drawio,
            "<!DOCTYPE mxfile [<!ENTITY s SYSTEM 'file:///etc/passwd'>]><mxfile>&s;</mxfile>",
        ),
        (
            DiagramFormat::Drawio,
            "<mxfile><diagram>eHl6</diagram></mxfile>",
        ),
    ] {
        // Act: проверяем каждый пример через браузер.
        let validation: DiagramValidation =
            engine.validate(format, source, MermaidTheme::Default).await;
        // Assert: ошибку входных данных отличают от сбоя браузера.
        assert_eq!(
            validation.syntax,
            ValidationStatus::Error,
            "{format:?}: {validation:?}"
        );
        assert!(validation.error.is_some());
    }
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn bpmn_lint_reports_missing_end_event() -> TestResult {
    // Arrange: исходник BPMN имеет стартовое событие без конечного.
    let engine = engine();
    // Act: проверяем исходник.
    let validation = engine
        .validate(DiagramFormat::Bpmn, BPMN, MermaidTheme::Default)
        .await;
    // Assert: отсутствует конечное событие, но синтаксис корректен.
    assert_eq!(validation.syntax, ValidationStatus::Ok, "{validation:?}");
    assert_eq!(validation.has_diagram, Some(false));
    let issues = validation.lint.ok_or("Нет замечаний bpmnlint")?;
    assert!(
        issues
            .iter()
            .any(|issue| issue.rule == "end-event-required")
    );
    Ok(())
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn bpmn_layout_produces_renderable_geometry() -> TestResult {
    // Arrange: исходник BPMN не содержит геометрии.
    let engine = engine();
    // Act: рассчитываем раскладку и строим снимок результата.
    let layout = engine.layout_bpmn(BPMN).await;
    assert!(layout.ok, "{layout:?}");
    let xml = layout.xml.ok_or("Нет BPMNDI")?;

    let result = engine
        .render(DiagramFormat::Bpmn, &xml, MermaidTheme::Default, true)
        .await;

    // Assert: геометрия позволяет отрисовать исходное событие.
    assert_eq!(
        result.validation.has_diagram,
        Some(true),
        "{:?}",
        result.validation
    );
    let render = result.render.ok_or("Нет SVG BPMN")?;
    assert!(render.svg.contains("<svg") && render.svg.contains("Start_1"));
    let png = STANDARD.decode(render.png_base64.ok_or("Нет PNG BPMN")?)?;
    assert!(png.starts_with(PNG_HEADER));
    Ok(())
}

#[tokio::test]
#[ignore = "требует сборку Vite desktop и Chrome Headless Shell"]
async fn drawio_exports_first_compressed_page() -> TestResult {
    // Arrange: первая страница сжата, вторая пуста.
    let engine = engine();
    let source = format!("<mxfile><diagram>{DRAWIO_PAGE}</diagram><diagram/></mxfile>");

    // Act: экспортируем документ.
    let outcome = engine
        .render(DiagramFormat::Drawio, &source, MermaidTheme::Default, true)
        .await;

    // Assert: SVG и PNG содержат первую страницу.
    assert_eq!(
        outcome.validation.syntax,
        ValidationStatus::Ok,
        "{:?}",
        outcome.validation
    );
    let render = outcome.render.ok_or("Нет SVG draw.io")?;
    assert!(render.svg.contains("<svg") && render.svg.contains("Привет"));
    let png = STANDARD.decode(render.png_base64.ok_or("Нет PNG draw.io")?)?;
    assert!(png.starts_with(PNG_HEADER));
    Ok(())
}

#[tokio::test]
#[ignore = "требует Chrome Headless Shell"]
async fn renderer_can_load_assets_but_cannot_load_vault_api() -> TestResult {
    // Arrange: ресурс API существует, локальный сервер слушает отдельный порт.
    let fixture = tempfile::tempdir()?;
    let root = fixture.path();
    fs::create_dir(root.join("assets"))?;
    fs::create_dir(root.join("drawio"))?;
    fs::create_dir(root.join("api"))?;
    fs::write(root.join("drawio/index.html"), "")?;
    fs::write(
        root.join("diagram-worker.html"),
        r#"<script src="/assets/probe.js"></script>"#,
    )?;
    let image = r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>"#;
    fs::write(root.join("assets/allowed.svg"), image)?;
    fs::write(root.join("api/blocked.svg"), image)?;
    fs::write(
        root.join("assets/probe.js"),
        r"
        const load = (url) => new Promise((resolve) => {
            const image = new Image();
            image.onload = () => resolve(true);
            image.onerror = () => resolve(false);
            image.src = url;
        });
        globalThis.livenoteDiagramWorker = async ({ source }) => ({
            syntax: await load('/assets/allowed.svg') ? 'ok' : 'error',
            renderer: 'playwright',
            warning: `${await load('/api/blocked.svg')},${await load(source)}`
        });
    ",
    )?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?;
    let url = format!("http://{addr}/api/probe");
    let engine = DiagramEngine::new(chrome(), root.to_path_buf());

    // Act: обработчик загружает ресурс и пробует оба адреса API.
    let validation = engine
        .validate(DiagramFormat::Mermaid, &url, MermaidTheme::Default)
        .await;

    // Assert: ресурс загрузился; оба запроса к API заблокированы.
    assert_eq!(validation.syntax, ValidationStatus::Ok, "{validation:?}");
    assert_eq!(validation.warning.as_deref(), Some("false,false"));
    assert!(matches!(listener.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock));
    Ok(())
}
