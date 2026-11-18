use crate::{
    ApiError,
    args::{Asset, Layout, WriteBlock, WriteDocument},
    assets::Check,
    diagram::format,
    edit::{byte_range, escape_label, fence, safe_title},
    links::{UrlStyle, relative_url},
    state::State,
    transaction::Plan,
};
use vault_read::{BlockType, Utf16Offset, diagram_format};

pub struct Edit {
    pub(crate) plan: Plan,
    pub(crate) id: String,
    pub(crate) revision: u64,
    pub(crate) checks: Vec<Check>,
}

impl State {
    pub(crate) fn edit_block(&self, body: WriteBlock, kind: BlockType) -> Result<Edit, ApiError> {
        let path = &body.page_id;
        let parsed = self.check(path, &body.expected)?;
        let document = parsed.document();
        let existing = body
            .block_id
            .as_ref()
            .and_then(|id| parsed.spans().iter().position(|span| &span.id == id));
        let old = existing.and_then(|i| document.page.blocks.get(i));
        let title = body
            .title
            .as_ref()
            .map(|title| title.trim().chars().take(200).collect::<String>());
        let same = old.is_some_and(|old| {
            old.kind == kind
                && old.source == body.source
                && title
                    .as_deref()
                    .is_none_or(|title| old.title.as_deref().unwrap_or_default() == title)
        });
        let mut plan = Plan::default();
        let mut checks = Vec::new();
        let (block_id, revision) = if same {
            (body.block_id.unwrap_or_default(), document.page.revision)
        } else {
            let span = existing.and_then(|i| parsed.spans().get(i));
            let start = span.map_or_else(
                || {
                    Utf16Offset(
                        body.at
                            .unwrap_or_else(|| parsed.source().encode_utf16().count()),
                    )
                },
                |span| span.start,
            );
            let end = span.map_or(start, |span| span.end);
            if span.is_none()
                && parsed.spans().iter().any(|span| {
                    span.kind != BlockType::Markdown && start > span.start && start < span.end
                })
            {
                return Err(ApiError::invalid("Некорректная позиция at"));
            }
            let nl = parsed.newline();
            let checked = format(kind).map(|format| (format, body.source.clone()));
            let input = BlockContent {
                source: body.source,
                title: title.as_deref(),
                kind,
            };
            let (mut replacement, assets) =
                self.block_content(input, parsed, (start, end, span, old))?;
            let mut source = parsed.source().to_owned();
            let range = byte_range(&source, start, end)?;
            if span.is_none()
                && range.start > 0
                && source.as_bytes().get(range.start.saturating_sub(1)) != Some(&b'\n')
            {
                replacement.insert_str(0, nl);
            }
            if span.is_none() && range.end < source.len() && !replacement.ends_with('\n') {
                replacement.push_str(nl);
            }
            source.replace_range(range, &replacement);
            let request = WriteDocument {
                path: path.clone(),
                expected: body.expected,
                source,
                assets,
                references: Vec::new(),
                request_id: None,
            };
            let candidate = self.write_document(&request, true)?;
            checks = candidate.checks;
            if let Some((format, source)) = checked {
                checks.retain(|check| !check.covers(format, &source));
            }
            plan = candidate.plan;
            let next = self.preview(path, &plan)?;
            let end = Utf16Offset(start.0.saturating_add(replacement.encode_utf16().count()));
            let derived = next
                .spans()
                .iter()
                .find(|span| span.kind == kind && span.start <= start && span.end >= end)
                .or_else(|| {
                    next.spans()
                        .iter()
                        .find(|span| span.kind == kind && span.start >= start)
                })
                .or_else(|| next.spans().first());
            (
                derived.map_or_else(String::new, |span| span.id.clone()),
                next.document().page.revision,
            )
        };
        Ok(Edit {
            plan,
            id: block_id,
            revision,
            checks,
        })
    }
    fn block_content(
        &self,
        input: BlockContent<'_>,
        parsed: &vault_read::ParsedDocument,
        slot: (
            Utf16Offset,
            Utf16Offset,
            Option<&vault_read::BlockSpan>,
            Option<&vault_read::Block>,
        ),
    ) -> Result<(String, Vec<Asset>), ApiError> {
        let (start, end, span, old) = slot;
        let range = (start, end);
        let kind = input.kind;
        let path = &parsed.document().path;
        let nl = parsed.newline();
        let mut assets = Vec::new();
        let replacement = if let Some(standalone) = diagram_format(path) {
            if BlockType::from(standalone) != kind {
                return Err(ApiError::invalid(
                    "Нельзя менять формат отдельной диаграммы",
                ));
            }
            input.source
        } else if let Some(asset_path) = span
            .and_then(|span| span.asset_path.as_ref())
            .filter(|_| old.is_some_and(|old| old.kind == kind))
        {
            let version = parsed
                .document()
                .assets
                .iter()
                .find(|asset| &asset.path == asset_path)
                .and_then(|asset| asset.version.clone());
            assets.push(Asset {
                path: asset_path.clone(),
                source: input.source,
                expected_version: version,
                layout: Layout::Preserve,
            });
            let existing = parsed
                .source()
                .get(byte_range(parsed.source(), range.0, range.1)?)
                .ok_or_else(|| ApiError::invalid("Некорректный диапазон вложения"))?;
            input.title.map_or_else(
                || existing.to_owned(),
                |title| change_label(existing, title),
            )
        } else {
            match kind {
                BlockType::Markdown => input.source,
                BlockType::Mermaid => fence(
                    &input.source,
                    input
                        .title
                        .or_else(|| old.and_then(|old| old.title.as_deref())),
                    nl,
                ),
                BlockType::Bpmn | BlockType::Drawio => {
                    let parent = path.rsplit_once('/').map_or_else(
                        || "Схемы".to_owned(),
                        |(parent, _)| format!("{parent}/Схемы"),
                    );
                    let ext = if kind == BlockType::Bpmn {
                        "bpmn"
                    } else {
                        "drawio"
                    };
                    let label = input.title.filter(|label| !label.is_empty());
                    let base = safe_title(&format!(
                        "{} — {}",
                        parsed.document().page.title,
                        label.unwrap_or(ext)
                    ));
                    let asset = self.unique(&format!("{parent}/{base}"), ext)?;
                    let url = relative_url(path, &asset, UrlStyle::default());
                    assets.push(Asset {
                        path: asset,
                        source: input.source,
                        expected_version: None,
                        layout: Layout::Preserve,
                    });
                    format!("![{}]({url}){nl}", escape_label(label.unwrap_or_default()))
                }
            }
        };
        Ok((replacement, assets))
    }
}

struct BlockContent<'a> {
    source: String,
    title: Option<&'a str>,
    kind: BlockType,
}

fn change_label(existing: &str, label: &str) -> String {
    if let Some((link, rest)) = existing
        .strip_prefix("![[")
        .and_then(|text| text.split_once("]]"))
    {
        let path = link.split_once('|').map_or(link, |(path, _)| path);
        return format!("![[{path}|{label}]]{rest}");
    }
    if let Some(text) = existing.strip_prefix("![") {
        let mut escaped = false;
        for (at, ch) in text.char_indices() {
            if !escaped && ch == ']' {
                if let Some(rest) = text.get(at..) {
                    return format!("![{}{rest}", escape_label(label));
                }
                break;
            }
            escaped = !escaped && ch == '\\';
        }
    }
    existing.to_owned()
}
