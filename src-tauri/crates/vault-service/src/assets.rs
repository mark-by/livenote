use crate::{
    ApiError,
    args::{Layout, WriteDocument},
    diagram::{format, invalid},
    source::Source,
    state::State,
    transaction::{Change, Plan},
};
use livenote_diagrams::DiagramFormat as EngineFormat;
use std::collections::BTreeSet;
use vault_read::{ParsedDocument, VaultDocument, parse_document, resolve_links};

fn references_asset(doc: &VaultDocument, path: &str) -> bool {
    doc.assets.iter().any(|asset| asset.path == path)
        || doc
            .links
            .iter()
            .any(|link| link.target_page_id.as_deref() == Some(path))
}

pub struct Check {
    pub(crate) format: EngineFormat,
    pub(crate) source: String,
    pub(crate) block: String,
    pub(crate) layout: Layout,
    pub(crate) path: String,
}

impl Check {
    pub fn covers(&self, kind: livenote_diagrams::DiagramFormat, source: &str) -> bool {
        self.format == kind
            && (self.source == source
                || (kind == livenote_diagrams::DiagramFormat::Mermaid
                    && self.source.replace("\r\n", "\n").trim_end_matches('\n')
                        == source.replace("\r\n", "\n").trim_end_matches('\n')))
    }
}

impl State {
    pub(crate) fn asset_guards(
        &self,
        plan: &mut Plan,
        doc: &VaultDocument,
    ) -> Result<(), ApiError> {
        for asset in &doc.assets {
            if plan
                .writes
                .iter()
                .any(|write| write.path.as_str() == asset.path)
            {
                continue;
            }
            let bytes = asset.source.as_ref().map(|text| text.as_bytes().to_vec());
            let guard = Change::new(&asset.path, bytes.clone(), bytes)?;
            if self.listing.files.contains(&asset.path) {
                plan.writes.push(guard);
            } else {
                plan.hidden_guards.push(guard);
            }
        }
        Ok(())
    }

    pub(crate) fn checks(
        &self,
        plan: &mut Plan,
        next: &ParsedDocument,
        previous: Option<&VaultDocument>,
        body: Option<&WriteDocument>,
    ) -> Result<Vec<Check>, ApiError> {
        let new = next.document();
        let mut seen = BTreeSet::new();
        let mut checks = Vec::new();
        for (block, span) in new.page.blocks.iter().zip(next.spans()) {
            let Some(kind) = format(block.kind) else {
                continue;
            };
            let (path, layout) = if let Some(path) = &span.asset_path {
                let new_asset = new.assets.iter().find(|asset| &asset.path == path);
                let old_asset =
                    previous.and_then(|old| old.assets.iter().find(|asset| &asset.path == path));
                let supplied =
                    body.and_then(|body| body.assets.iter().find(|asset| &asset.path == path));
                if !seen.insert(path)
                    || (supplied.is_none() && old_asset.is_some_and(|old| Some(old) == new_asset))
                {
                    continue;
                }
                if new_asset.and_then(|asset| asset.source.as_ref()).is_none() {
                    return Err(invalid(&block.id, None));
                }
                (
                    path.clone(),
                    supplied.map_or(Layout::Preserve, |asset| asset.layout),
                )
            } else {
                if previous.is_some_and(|doc| {
                    doc.page
                        .blocks
                        .iter()
                        .any(|old| old.kind == block.kind && old.source == block.source)
                }) {
                    continue;
                }
                (new.path.clone(), Layout::Preserve)
            };
            checks.push(Check {
                format: kind,
                source: block.source.clone(),
                block: block.id.clone(),
                layout,
                path,
            });
        }
        self.asset_guards(plan, new)?;
        Ok(checks)
    }

    pub(crate) fn collect_unused(
        &self,
        plan: &mut Plan,
        previous: &VaultDocument,
        next: Option<&VaultDocument>,
    ) -> Result<(), ApiError> {
        if previous.assets.is_empty()
            || !self.listing.ignored_folders.is_empty()
            || !self.listing.problems.is_empty()
            || self.listing.files.iter().any(|path| {
                vault_read::openable(path)
                    && vault_read::diagram_format(path).is_none()
                    && self.projection.document(path).is_none()
            })
        {
            return Ok(());
        }
        let other_documents = || {
            self.projection
                .documents()
                .map(ParsedDocument::document)
                .filter(|doc| doc.path != previous.path)
        };
        // При прямом разборе редакции поле links ещё пусто: его заполняет проекция.
        let next_targets = if let Some(doc) = next.filter(|doc| doc.links.is_empty()) {
            let parsed = parse_document(&doc.path, &doc.source, |path| {
                Source(&self.files).asset(path)
            })?;
            if parsed.links().is_empty() {
                BTreeSet::new()
            } else {
                let pages = other_documents()
                    .chain(std::iter::once(doc))
                    .collect::<Vec<_>>();
                resolve_links(&parsed, &pages, &self.listing.files)
                    .into_iter()
                    .filter_map(|span| span.link.target_page_id)
                    .collect()
            }
        } else {
            BTreeSet::new()
        };
        for asset in &previous.assets {
            if !self.listing.files.contains(&asset.path)
                || next.is_some_and(|doc| references_asset(doc, &asset.path))
                || next_targets.contains(&asset.path)
                || other_documents().any(|doc| references_asset(doc, &asset.path))
            {
                continue;
            }
            if let Some(source) = &asset.source {
                plan.writes.push(Change::new(
                    &asset.path,
                    Some(source.as_bytes().to_vec()),
                    None,
                )?);
            }
        }
        Ok(())
    }
}
