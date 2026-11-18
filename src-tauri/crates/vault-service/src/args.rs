use livenote_diagrams::MermaidTheme;
use serde::Deserialize;
use vault_read::DiagramFormat;

#[derive(Deserialize)]
pub struct PathArg {
    #[serde(alias = "page_id")]
    pub path: String,
}

#[derive(Deserialize, Clone)]
pub struct Expected {
    #[serde(alias = "expectedRevision")]
    pub expected_revision: u64,
    #[serde(alias = "expectedVersion")]
    pub expected_version: Option<String>,
}

#[derive(Deserialize)]
pub struct Create {
    pub title: String,
    pub path: Option<String>,
    pub source: Option<String>,
    pub format: Option<DiagramFormat>,
    #[serde(alias = "requestId")]
    pub request_id: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct Import {
    pub content: String,
    pub title: Option<String>,
    pub path: Option<String>,
}

#[derive(Deserialize)]
pub struct WriteDocument {
    pub path: String,
    #[serde(flatten)]
    pub expected: Expected,
    pub source: String,
    #[serde(default)]
    pub assets: Vec<Asset>,
    #[serde(default)]
    pub references: Vec<Reference>,
    #[serde(alias = "requestId")]
    pub request_id: Option<String>,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Layout {
    #[default]
    Preserve,
    Auto,
}

#[derive(Deserialize)]
pub struct Asset {
    pub path: String,
    pub source: String,
    #[serde(alias = "expectedVersion", deserialize_with = "nullable")]
    pub expected_version: Option<String>,
    #[serde(default)]
    pub layout: Layout,
}

fn nullable<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    Option::deserialize(deserializer)
}

#[derive(Deserialize)]
pub struct Reference {
    pub path: String,
    #[serde(alias = "expectedVersion")]
    pub expected_version: String,
}

#[derive(Deserialize)]
pub struct WriteBlock {
    pub page_id: String,
    pub block_id: Option<String>,
    pub format: Option<DiagramFormat>,
    pub source: String,
    #[serde(flatten)]
    pub expected: Expected,
    pub title: Option<String>,
    pub at: Option<usize>,
    pub request_id: Option<String>,
    #[serde(default)]
    pub layout: Layout,
}

#[derive(Deserialize)]
pub struct LayoutDiagram {
    pub page_id: String,
    pub block_id: String,
    #[serde(flatten)]
    pub expected: Expected,
}

#[derive(Deserialize)]
pub struct Update {
    pub page_id: String,
    #[serde(flatten)]
    pub expected: Expected,
    pub title: Option<String>,
    pub block_order: Option<Vec<String>>,
    pub delete_block_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct Delete {
    pub page_id: String,
    pub block_id: Option<String>,
    #[serde(flatten)]
    pub expected: Expected,
}

#[derive(Deserialize)]
pub struct Metadata {
    pub path: String,
    #[serde(flatten)]
    pub expected: Expected,
    pub title: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct MoveDocument {
    #[serde(alias = "path")]
    pub from: String,
    pub to: String,
    #[serde(flatten)]
    pub expected: Expected,
}

#[derive(Deserialize)]
pub struct Folder {
    pub path: String,
    pub from: Option<String>,
    pub expected_tree_version: String,
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Deserialize)]
pub struct Search {
    #[serde(default)]
    pub q: String,
    pub tag: Option<String>,
}

#[derive(Deserialize)]
pub struct Diagram {
    pub page_id: String,
    pub block_id: String,
    pub revision: Option<u64>,
    pub theme: Option<MermaidTheme>,
    #[serde(default)]
    pub mode: CheckMode,
    #[serde(default)]
    pub include_image: bool,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckMode {
    #[default]
    Syntax,
    Render,
}

#[derive(Deserialize)]
pub struct Rendered {
    pub page_id: String,
    pub block_id: String,
    pub revision: u64,
    pub ok: bool,
    pub error: Option<String>,
}
