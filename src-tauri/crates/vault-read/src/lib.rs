//! Проекция Vault из проверенных наблюдений файловой системы.

mod document;
mod file_input;
mod identity;
mod index;
mod index_location;
mod links;
mod markdown;
mod markdown_blocks;
mod metadata;
mod model;
mod observations;
mod offsets;
mod paths;
mod projection;
mod prose;
mod record;
mod snapshot;
mod wiki;

pub use document::{BlockSpan, ParsedDocument, parse_document};
pub use file_input::{AssetRead, DocumentInput, FileTimes};
pub use identity::{
    Fingerprint, file_version, fingerprint, sha256, vault_cache_path, vault_id_for_root,
};
pub use index::VaultIndex;
pub use links::{LinkSpan, link_spans, resolve_links};
pub use model::{
    Block, BlockType, DiagramFormat, DocumentProblem, LinkKind, PageFull, ProblemCode, Utf16Offset,
    VaultAsset, VaultBacklink, VaultDocument, VaultLink, VaultProblem, VaultSourceSpan,
};
pub use observations::{StagedFile, VaultScan};
pub use paths::{diagram_format, openable};
pub use projection::VaultProjection;
pub use record::{FileBytes, FileFailure, VaultReadSource};
pub use snapshot::{
    SearchError, VaultFileSummary, VaultPageSummary, VaultSearchHit, VaultSnapshot, VaultTagCount,
};
