use std::num::NonZeroUsize;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use livenote_diagrams::{DiagramFormat, DiagramValidation};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Base {
    pub revision: u64,
    pub version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum CapturedFocus {
    Folder {
        folder: String,
    },
    Document {
        path: String,
        base: Base,
    },
    Diagram {
        path: String,
        base: Base,
        format: DiagramFormat,
        target: Target,
        selected: Vec<ElementRef>,
        overlay: Option<Overlay>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    File,
    Asset { path: String },
    Inline { from: usize, to: usize },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementRef {
    pub id: String,
    pub kind: ElementKind,
    pub page_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ElementKind {
    Node,
    Edge,
    Element,
}

/// Черновик редактора. Поле `requestId` не входит в эту форму.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Overlay {
    pub expected_revision: u64,
    pub expected_version: String,
    pub source: String,
    #[serde(default)]
    pub assets: Vec<OverlayAsset>,
    #[serde(default)]
    pub references: Vec<OverlayReference>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlayAsset {
    pub path: String,
    pub source: String,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub expected_version: Option<String>,
    #[serde(default)]
    pub layout: Layout,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlayReference {
    pub path: String,
    pub expected_version: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layout {
    #[default]
    Preserve,
    Auto,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Edit {
    Create {
        path: String,
        source: String,
    },
    Patch {
        read_id: ReadId,
        edits: Vec<Patch>,
        layout: Layout,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Patch {
    pub from: usize,
    pub to: usize,
    pub old: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ReadId(pub Uuid);

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub text: String,
    pub limit: usize,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lines {
    pub first: usize,
    pub last: usize,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CiteKind {
    Vault,
}

#[derive(Debug, Clone, Serialize)]
pub struct Cite {
    pub kind: CiteKind,
    pub path: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    #[serde(rename = "ref")]
    pub reference: Uuid,
    pub cite: Cite,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Fragment {
    pub cite: Cite,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Read {
    pub read_id: ReadId,
    pub version: String,
    pub offset: usize,
    pub fragment: Fragment,
    #[serde(skip)]
    pub target: NavigationTarget,
}

/// Путь и позиция в проверенном снимке хранилища.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationTarget {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<NonZeroUsize>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pending_publish: bool,
}

impl NavigationTarget {
    pub(super) const fn new(
        path: String,
        line: Option<NonZeroUsize>,
        pending_publish: bool,
    ) -> Self {
        Self {
            path,
            line,
            pending_publish,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagramInput {
    pub format: DiagramFormat,
    pub source: String,
}

/// Добавляет диаграмму в конец страницы.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageDiagram {
    pub page_path: String,
    pub format: DiagramFormat,
    pub source: String,
    pub title: Option<String>,
}

/// Описывает диаграмму после проверки, до публикации.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedDiagram {
    pub page_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_path: Option<String>,
    pub validation: DiagramValidation,
    #[serde(skip)]
    pub target: NavigationTarget,
}

#[derive(Debug, Clone)]
pub struct VersionedBytes {
    pub version: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct CasBytes {
    pub expected_version: Option<String>,
    pub bytes: Vec<u8>,
}
