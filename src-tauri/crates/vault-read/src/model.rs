use serde::{Deserialize, Serialize};

/// Формат отдельной диаграммы.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagramFormat {
    Mermaid,
    Bpmn,
    Drawio,
}

impl DiagramFormat {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Mermaid => "mermaid",
            Self::Bpmn => "bpmn",
            Self::Drawio => "drawio",
        }
    }
}

/// Формат блока или открываемого файла.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockType {
    Markdown,
    Mermaid,
    Bpmn,
    Drawio,
}

impl From<DiagramFormat> for BlockType {
    fn from(value: DiagramFormat) -> Self {
        match value {
            DiagramFormat::Mermaid => Self::Mermaid,
            DiagramFormat::Bpmn => Self::Bpmn,
            DiagramFormat::Drawio => Self::Drawio,
        }
    }
}

/// Смещение в единицах UTF-16, как в строках JavaScript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Utf16Offset(pub usize);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    pub page_id: String,
    #[serde(rename = "type")]
    pub kind: BlockType,
    pub source: String,
    pub title: Option<String>,
    pub position: usize,
    pub created_at: String,
    pub updated_at: String,
    pub rendered_revision: Option<u64>,
    pub render_ok: Option<bool>,
    pub render_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageFull {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VaultAsset {
    #[serde(rename = "type")]
    pub kind: DiagramFormat,
    pub path: String,
    pub source: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSourceSpan {
    pub block_id: String,
    #[serde(rename = "type")]
    pub kind: BlockType,
    pub from: Utf16Offset,
    pub to: Utf16Offset,
    pub source_from: Utf16Offset,
    pub source_to: Utf16Offset,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProblemCode {
    MissingId,
    InvalidFrontmatter,
    DuplicatePageId,
    InvalidBlock,
    DuplicateBlockId,
    MissingAsset,
    UnsafePath,
    GitConflict,
    UnreadableFile,
}

impl ProblemCode {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::MissingId => "missing_id",
            Self::InvalidFrontmatter => "invalid_frontmatter",
            Self::DuplicatePageId => "duplicate_page_id",
            Self::InvalidBlock => "invalid_block",
            Self::DuplicateBlockId => "duplicate_block_id",
            Self::MissingAsset => "missing_asset",
            Self::UnsafePath => "unsafe_path",
            Self::GitConflict => "git_conflict",
            Self::UnreadableFile => "unreadable_file",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct VaultProblem {
    pub code: ProblemCode,
    pub path: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
}

pub type DocumentProblem = VaultProblem;

impl VaultProblem {
    pub(crate) fn document(code: ProblemCode, path: &str, message: &str) -> Self {
        Self {
            code,
            path: path.to_owned(),
            message: message.to_owned(),
            page_id: Some(path.to_owned()),
            block_id: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Markdown,
    Wiki,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultLink {
    pub target: String,
    pub target_page_id: Option<String>,
    pub label: Option<String>,
    pub kind: LinkKind,
    pub fragment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultBacklink {
    pub page_id: String,
    pub title: String,
    pub path: String,
}

/// Документ для REST и MCP. Поле `source` содержит исходный текст без преобразований.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultDocument {
    pub page: PageFull,
    pub path: String,
    pub source: String,
    pub version: String,
    pub spans: Vec<VaultSourceSpan>,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub assets: Vec<VaultAsset>,
    pub links: Vec<VaultLink>,
    pub backlinks: Vec<VaultBacklink>,
}
