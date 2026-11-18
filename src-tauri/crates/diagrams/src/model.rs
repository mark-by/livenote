use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagramFormat {
    Mermaid,
    Bpmn,
    Drawio,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MermaidTheme {
    #[default]
    Default,
    Base,
    Dark,
    Forest,
    Neutral,
    Neo,
    NeoDark,
    Redux,
    ReduxDark,
    ReduxColor,
    ReduxDarkColor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationStatus {
    Ok,
    Error,
    NotChecked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RendererKind {
    Playwright,
    Ui,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagramDiagnostic {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LintSeverity {
    Error,
    Warn,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BpmnLintIssue {
    pub rule: String,
    pub severity: LintSeverity,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramValidation {
    pub syntax: ValidationStatus,
    pub renderer: RendererKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagram_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<DiagramDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lint: Option<Vec<BpmnLintIssue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_diagram: Option<bool>,
}

impl DiagramValidation {
    pub(crate) const UNAVAILABLE: Self = Self {
        syntax: ValidationStatus::NotChecked,
        renderer: RendererKind::Unavailable,
        diagram_type: None,
        error: None,
        warning: None,
        lint: None,
        has_diagram: None,
    };
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramRenderResult {
    pub svg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub png_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiagramRenderOutcome {
    pub validation: DiagramValidation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render: Option<DiagramRenderResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BpmnLayoutOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xml: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
