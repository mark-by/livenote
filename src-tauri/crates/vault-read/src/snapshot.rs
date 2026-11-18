use std::collections::BTreeMap;

use serde::Serialize;

use crate::{
    BlockType, ParsedDocument, VaultDocument, VaultProblem, VaultProjection, diagram_format,
    links::{folded, locale_cmp, utf16_cmp},
    paths::WHITESPACE,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultPageSummary {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    pub path: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VaultFileSummary {
    pub path: String,
    pub kind: BlockType,
    pub title: String,
    pub version: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VaultTagCount {
    pub tag: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_name: Option<String>,
    pub pages: Vec<VaultPageSummary>,
    pub files: Vec<VaultFileSummary>,
    pub folders: Vec<String>,
    pub tree_version: String,
    pub tags: Vec<VaultTagCount>,
    pub problems: Vec<VaultProblem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSearchHit {
    pub page_id: String,
    pub title: String,
    pub path: String,
    pub tags: Vec<String>,
    pub excerpt: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Поиск ограничен 500 символами")]
pub struct SearchError;

pub(crate) fn build(
    projection: &VaultProjection,
    vault_name: Option<&str>,
    folders: &[String],
) -> VaultSnapshot {
    let mut documents: Vec<_> = projection
        .documents()
        .map(ParsedDocument::document)
        .collect();
    documents.sort_by(|a, b| locale_cmp(&a.path, &b.path));
    let mut counts = BTreeMap::new();
    let pages = documents
        .iter()
        .filter(|doc| doc.path.ends_with(".md"))
        .map(|doc| {
            for tag in &doc.tags {
                *counts.entry(tag.clone()).or_insert(0usize) += 1;
            }
            VaultPageSummary {
                id: doc.path.clone(),
                title: doc.page.title.clone(),
                revision: doc.page.revision,
                created_at: doc.page.created_at.clone(),
                updated_at: doc.page.updated_at.clone(),
                path: doc.path.clone(),
                aliases: doc.aliases.clone(),
                tags: doc.tags.clone(),
            }
        })
        .collect();
    let files = documents
        .into_iter()
        .map(|doc| VaultFileSummary {
            path: doc.path.clone(),
            kind: diagram_format(&doc.path).map_or(BlockType::Markdown, BlockType::from),
            title: doc.page.title.clone(),
            version: doc.version.clone(),
            revision: doc.page.revision,
        })
        .collect();
    let mut tags: Vec<_> = counts
        .into_iter()
        .map(|(tag, count)| VaultTagCount { tag, count })
        .collect();
    tags.sort_by(|a, b| locale_cmp(&a.tag, &b.tag));
    VaultSnapshot {
        vault_name: vault_name.map(str::to_owned),
        pages,
        files,
        folders: folders.to_vec(),
        tree_version: projection.tree_version().to_owned(),
        tags,
        problems: projection.problems().to_vec(),
    }
}

pub(crate) fn search(
    projection: &VaultProjection,
    query: &str,
    tag: Option<&str>,
) -> Result<Vec<VaultSearchHit>, SearchError> {
    if query.encode_utf16().take(501).count() > 500 {
        return Err(SearchError);
    }
    let query = folded(query);
    let tokens: Vec<_> = WHITESPACE
        .split(&query)
        .filter(|token| !token.is_empty())
        .collect();
    let mut results = Vec::new();
    for page in projection.documents() {
        let VaultDocument {
            path,
            tags,
            aliases,
            page: full,
            ..
        } = page.document();
        if !path.ends_with(".md")
            || tag.is_some_and(|tag| !tags.iter().any(|existing| existing == tag))
        {
            continue;
        }
        let prose = WHITESPACE.replace_all(page.prose(), " ");
        let haystack = std::iter::once(full.title.as_str())
            .chain(aliases.iter().map(String::as_str))
            .chain([path.as_str(), prose.as_ref()])
            .collect::<Vec<_>>()
            .join("\n");
        let haystack = folded(&haystack);
        if tokens.iter().all(|token| haystack.contains(token)) {
            let prefix: Vec<_> = prose.encode_utf16().take(240).collect();
            results.push(VaultSearchHit {
                page_id: path.clone(),
                title: full.title.clone(),
                path: path.clone(),
                tags: tags.clone(),
                excerpt: String::from_utf16_lossy(&prefix),
            });
        }
    }
    results.sort_by(|a, b| locale_cmp(&a.path, &b.path).then_with(|| utf16_cmp(&a.path, &b.path)));
    results.truncate(100);
    Ok(results)
}
