use base64::Engine as _;
use livenote_diagrams::{
    DiagramDiagnostic, DiagramEngine, DiagramFormat, DiagramValidation, MermaidTheme,
    ValidationStatus,
};
use serde_json::{Map, Value, json};
use vault_read::BlockType;

use crate::{
    ApiError, Output,
    args::{CheckMode, Diagram, Layout},
    state::State,
};

pub const fn format(kind: BlockType) -> Option<DiagramFormat> {
    match kind {
        BlockType::Markdown => None,
        BlockType::Mermaid => Some(DiagramFormat::Mermaid),
        BlockType::Bpmn => Some(DiagramFormat::Bpmn),
        BlockType::Drawio => Some(DiagramFormat::Drawio),
    }
}

pub struct Validator {
    pub(crate) engine: DiagramEngine,
    pub(crate) theme: MermaidTheme,
}

pub struct Check {
    pub(crate) args: Diagram,
    pub(crate) revision: u64,
    pub(crate) kind: BlockType,
    pub(crate) source: String,
}

impl State {
    pub(crate) fn diagram(&self, args: Diagram) -> Result<Check, ApiError> {
        let page = &self.require(&args.page_id)?.document().page;
        let block = page
            .blocks
            .iter()
            .find(|block| block.id == args.block_id)
            .ok_or_else(|| ApiError::block(&args.page_id, &args.block_id))?;
        Ok(Check {
            args,
            revision: page.revision,
            kind: block.kind,
            source: block.source.clone(),
        })
    }
}

impl Validator {
    pub(crate) async fn validate(
        &self,
        kind: DiagramFormat,
        source: &str,
        layout: Layout,
    ) -> (Option<String>, DiagramValidation) {
        let mut validation = self.engine.validate(kind, source, self.theme).await;
        if kind != DiagramFormat::Bpmn || validation.syntax != ValidationStatus::Ok {
            return (None, validation);
        }
        let has_diagram = validation.has_diagram == Some(true);
        match layout {
            Layout::Preserve if has_diagram => (None, validation),
            Layout::Preserve => {
                validation.syntax = ValidationStatus::Error;
                validation.error = Some(DiagramDiagnostic {
                    message: "XML без BPMNDI. Укажите layout: \"auto\".".into(),
                    line: None,
                });
                (None, validation)
            }
            Layout::Auto => {
                let result = self.engine.layout_bpmn(source).await;
                if let (true, Some(xml)) = (result.ok, result.xml) {
                    validation = self.engine.validate(kind, &xml, self.theme).await;
                    if validation.syntax == ValidationStatus::Ok
                        && validation.has_diagram != Some(true)
                    {
                        validation.syntax = ValidationStatus::Error;
                        validation.error = Some(DiagramDiagnostic {
                            message: "Раскладка не добавила BPMNDI".into(),
                            line: None,
                        });
                    }
                    validation.warning = Some(
                        if has_diagram {
                            "Раскладка пересчитана: ручное расположение элементов могло измениться"
                        } else {
                            "Добавлена автораскладка (XML не содержал BPMNDI)"
                        }
                        .into(),
                    );
                    (Some(xml), validation)
                } else {
                    validation.syntax = ValidationStatus::Error;
                    let message = result.error.unwrap_or_else(|| "неизвестная ошибка".into());
                    validation.error = Some(DiagramDiagnostic {
                        message: format!("Автораскладка не удалась: {message}"),
                        line: None,
                    });
                    (None, validation)
                }
            }
        }
    }

    pub(crate) async fn check(&self, check: Check, png: bool) -> Result<Output, ApiError> {
        let Check {
            args,
            revision,
            kind,
            source,
        } = check;
        let mut output = result_fields(&args.page_id, &args.block_id, revision);
        output.insert("stale".into(), json!(false));
        if args.revision.is_some_and(|expected| expected != revision) {
            output.insert("stale".into(), json!(true));
            output.insert(
                "validation".into(),
                json!({"syntax":"not_checked","renderer":"unavailable"}),
            );
            return Ok(Output::Json(Value::Object(output)));
        }
        let (validation, render) = match args.mode {
            CheckMode::Syntax if !png => (
                self.engine
                    .validate(
                        format(kind).unwrap_or(DiagramFormat::Mermaid),
                        &source,
                        self.theme,
                    )
                    .await,
                None,
            ),
            CheckMode::Syntax | CheckMode::Render => {
                let kind = format(kind).ok_or_else(|| {
                    ApiError::invalid("Блок Markdown нельзя проверить как диаграмму")
                })?;
                let theme = if png && kind == DiagramFormat::Mermaid {
                    args.theme.unwrap_or(self.theme)
                } else {
                    self.theme
                };
                let result = self
                    .engine
                    .render(kind, &source, theme, png || args.include_image)
                    .await;
                (result.validation, result.render)
            }
        };
        if png {
            let data = render.and_then(|result| result.png_base64).ok_or_else(|| {
                ApiError::invalid("PNG-экспорт недоступен")
                    .details(json!({"renderer":validation.renderer,"syntax":validation.syntax}))
            })?;
            return base64::engine::general_purpose::STANDARD
                .decode(data)
                .map(Output::Bytes)
                .map_err(ApiError::internal);
        }
        output.insert("validation".into(), serde_json::to_value(validation)?);
        if let Some(render) = render {
            output.insert("render".into(), serde_json::to_value(render)?);
        }
        Ok(Output::Json(Value::Object(output)))
    }
}

pub fn invalid(block: &str, validation: Option<&DiagramValidation>) -> ApiError {
    let mut data = Map::from_iter([("blockId".into(), json!(block))]);
    if let Some(validation) = validation {
        data.insert("validation".into(), json!(validation));
    }
    ApiError::new(422, "diagram_invalid", "Не удалось проверить диаграмму")
        .details(Value::Object(data))
}

fn result_fields(page: &str, block: &str, revision: u64) -> Map<String, Value> {
    Map::from_iter([
        ("pageId".into(), json!(page)),
        ("blockId".into(), json!(block)),
        ("revision".into(), json!(revision)),
    ])
}
