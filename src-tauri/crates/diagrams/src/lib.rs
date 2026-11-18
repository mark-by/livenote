mod assets;
mod browser;
mod cdp;
mod error;
mod launch;
mod model;

use std::{path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::{sync::Mutex, time::timeout};

use browser::{Browser, Clip, Page};

pub use error::DiagramError;
pub use model::{
    BpmnLayoutOutcome, BpmnLintIssue, DiagramDiagnostic, DiagramFormat, DiagramRenderOutcome,
    DiagramRenderResult, DiagramValidation, LintSeverity, MermaidTheme, RendererKind,
    ValidationStatus,
};

const JOB_TIMEOUT: Duration = Duration::from_secs(30);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Serialize)]
struct Diagram<'a> {
    format: DiagramFormat,
    source: &'a str,
    theme: MermaidTheme,
}

#[derive(Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum Request<'a> {
    Validate {
        #[serde(flatten)]
        diagram: Diagram<'a>,
    },
    Render {
        #[serde(flatten)]
        diagram: Diagram<'a>,
        #[serde(rename = "includePng")]
        include_png: bool,
    },
    LayoutBpmn {
        source: &'a str,
    },
}

#[derive(Deserialize)]
struct Rendered {
    outcome: DiagramRenderOutcome,
    clip: Option<Clip>,
}

/// Проверяет диаграммы в изолированном процессе Chrome for Testing.
pub struct DiagramEngine {
    chromium: PathBuf,
    web_root: PathBuf,
    browser: Mutex<Option<Browser>>,
}

impl DiagramEngine {
    /// `web_root` указывает на результат сборки Vite с обработчиком и каталогом draw.io.
    #[must_use]
    pub const fn new(chromium: PathBuf, web_root: PathBuf) -> Self {
        Self {
            chromium,
            web_root,
            browser: Mutex::const_new(None),
        }
    }

    /// Запускает Chromium и загружает обработчик.
    ///
    /// # Errors
    /// Возвращает ошибку, если Chromium или файлы обработчика недоступны.
    pub async fn warm_up(&self) -> Result<(), DiagramError> {
        self.with_page(async |_, _| Ok(())).await
    }

    /// Проверяет синтаксис и возвращает замечания bpmnlint для BPMN.
    pub async fn validate(
        &self,
        format: DiagramFormat,
        source: &str,
        theme: MermaidTheme,
    ) -> DiagramValidation {
        let request = Request::Validate {
            diagram: Diagram {
                format,
                source,
                theme,
            },
        };
        self.with_page(async |browser, page| browser.run(page, &request).await)
            .await
            .unwrap_or(DiagramValidation::UNAVAILABLE)
    }

    /// Возвращает SVG и по запросу снимок PNG.
    // Параметры сохраняют согласованный контракт вызывающего сервиса.
    pub async fn render(
        &self,
        format: DiagramFormat,
        source: &str,
        theme: MermaidTheme,
        include_png: bool,
    ) -> DiagramRenderOutcome {
        let request = Request::Render {
            diagram: Diagram {
                format,
                source,
                theme,
            },
            include_png,
        };
        let outcome = self
            .with_page(async |browser, page| {
                let Rendered { mut outcome, clip } = browser.run(page, &request).await?;
                if let (Some(render), Some(clip)) = (&mut outcome.render, clip) {
                    render.png_base64 = browser.screenshot(page, clip).await.unwrap_or(None);
                }
                Ok(outcome)
            })
            .await;
        outcome.unwrap_or(DiagramRenderOutcome {
            validation: DiagramValidation::UNAVAILABLE,
            render: None,
        })
    }

    /// Пересчитывает геометрию BPMNDI.
    pub async fn layout_bpmn(&self, source: &str) -> BpmnLayoutOutcome {
        let request = Request::LayoutBpmn { source };
        self.with_page(async |browser, page| browser.run(page, &request).await)
            .await
            .unwrap_or_else(|error| BpmnLayoutOutcome {
                ok: false,
                xml: None,
                error: Some(error.to_string()),
            })
    }

    async fn with_page<T>(
        &self,
        job: impl AsyncFnOnce(&mut Browser, &Page) -> Result<T, DiagramError>,
    ) -> Result<T, DiagramError> {
        // Владеем браузером на время задания: отмена или сбой закрывает процесс и его каналы.
        let mut slot = self.browser.lock().await;
        let owned = slot.take();
        let (mut browser, page, outcome) = timeout(JOB_TIMEOUT, async {
            let mut browser = match owned {
                Some(browser) => browser,
                None => Browser::launch(&self.chromium, &self.web_root).await?,
            };
            let page = browser.page().await?;
            let outcome = job(&mut browser, &page).await?;
            Ok::<_, DiagramError>((browser, page, outcome))
        })
        .await
        .map_err(|_| DiagramError::Timeout)??;
        // Если страница не закрылась, процесс не возвращается в пул. Готовый результат сохраняется.
        if matches!(
            timeout(CLOSE_TIMEOUT, browser.close(page)).await,
            Ok(Ok(()))
        ) {
            *slot = Some(browser);
        }
        drop(slot);
        Ok(outcome)
    }
}
