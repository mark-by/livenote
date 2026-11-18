use std::{collections::HashMap, sync::Arc, time::UNIX_EPOCH};

use serde::{Serialize, Serializer};

use crate::{
    AssetRead, Block, BlockType, DocumentInput, DocumentProblem, FileFailure, FileTimes, LinkSpan,
    PageFull, Utf16Offset, VaultAsset, VaultBacklink, VaultDocument, VaultProblem, VaultSourceSpan,
    file_input::iso8601,
    file_version, fingerprint,
    markdown::{self, Syntax},
    offsets::Offsets,
    paths::{basename, extension},
};

/// Исходные диапазоны блока. Все смещения используют UTF-16.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockSpan {
    pub id: String,
    pub kind: BlockType,
    pub start: Utf16Offset,
    pub end: Utf16Offset,
    pub content_start: Utf16Offset,
    pub content_end: Utf16Offset,
    pub asset_path: Option<String>,
    pub destination_start: Option<Utf16Offset>,
    pub destination_end: Option<Utf16Offset>,
    pub title: Option<String>,
}

/// Документ с исходными диапазонами, диагностикой и текстом поиска.
#[derive(Debug, Clone)]
pub struct ParsedDocument {
    document: VaultDocument,
    spans: Vec<BlockSpan>,
    links: Vec<LinkSpan>,
    syntax: Arc<Syntax>,
    problems: Vec<VaultProblem>,
}

impl Serialize for ParsedDocument {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.document.serialize(serializer)
    }
}

impl ParsedDocument {
    /// Разбирает исходный текст. Загрузчик вызывается один раз на каждый путь диаграммы.
    ///
    /// # Errors
    /// Возвращает диагностику, если исходный текст содержит конфликт Git.
    pub fn parse(
        input: DocumentInput<'_>,
        load_asset: impl FnMut(&str) -> Result<AssetRead, FileFailure>,
    ) -> Result<Self, DocumentProblem> {
        let syntax = Arc::new(markdown::parse(input.source, input.path)?);
        Ok(Self::materialize(input, syntax, load_asset))
    }

    /// Возвращает публичное представление документа.
    pub const fn document(&self) -> &VaultDocument {
        &self.document
    }
    /// Возвращает документ с полями для сериализации.
    pub fn into_document(self) -> VaultDocument {
        self.document
    }
    /// Возвращает исходный UTF-8 без преобразований.
    pub fn source(&self) -> &str {
        &self.document.source
    }
    /// Возвращает диапазоны блоков и назначений в исходном тексте.
    pub fn spans(&self) -> &[BlockSpan] {
        &self.spans
    }
    /// Возвращает исходные диапазоны ссылок.
    pub fn links(&self) -> &[LinkSpan] {
        &self.links
    }
    /// Возвращает диагностику документа и его диаграмм.
    pub fn problems(&self) -> &[VaultProblem] {
        &self.problems
    }
    /// Возвращает текст Markdown, который участвует в поиске.
    pub fn prose(&self) -> &str {
        &self.syntax.prose
    }
    /// Возвращает CRLF, если исходный текст содержит CRLF.
    pub fn newline(&self) -> &'static str {
        if self.source().contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        }
    }
    /// Возвращает начало тела документа, включая его необязательный YAML.
    pub const fn body_start(&self) -> Utf16Offset {
        Utf16Offset(0)
    }

    pub(crate) fn set_graph(&mut self, links: Vec<LinkSpan>, backlinks: Vec<VaultBacklink>) {
        self.document.links = links.iter().map(|span| span.link.clone()).collect();
        self.document.backlinks = backlinks;
        self.links = links;
    }

    pub(crate) fn same_graph_input(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.syntax, &other.syntax)
            || (self.syntax.aliases == other.syntax.aliases
                && self.syntax.links == other.syntax.links)
    }

    pub(crate) fn materialize(
        input: DocumentInput<'_>,
        syntax: Arc<Syntax>,
        mut load_asset: impl FnMut(&str) -> Result<AssetRead, FileFailure>,
    ) -> Self {
        let DocumentInput {
            path,
            source,
            times,
        } = input;
        let mut problems = syntax.problems.clone();
        let offsets = Offsets::new(source);
        let mut positions = HashMap::new();
        let mut assets: Vec<VaultAsset> = Vec::new();
        let mut latest = times.modified;
        let created_at = iso8601(
            times
                .created
                .filter(|&time| time != UNIX_EPOCH)
                .unwrap_or(times.modified),
        );
        let mut spans = Vec::new();
        let mut blocks = Vec::new();
        let mut public_spans = Vec::new();
        for (position, span) in syntax.spans.iter().enumerate() {
            let id = format!("span-{position}");
            let projected = BlockSpan {
                id: id.clone(),
                kind: span.kind,
                start: offsets.at(span.full.start),
                end: offsets.at(span.full.end),
                content_start: offsets.at(span.content.start),
                content_end: offsets.at(span.content.end),
                asset_path: span.embed.as_ref().map(|embed| embed.path.clone()),
                destination_start: span
                    .embed
                    .as_ref()
                    .and_then(|embed| embed.destination.as_ref())
                    .map(|range| offsets.at(range.start)),
                destination_end: span
                    .embed
                    .as_ref()
                    .and_then(|embed| embed.destination.as_ref())
                    .map(|range| offsets.at(range.end)),
                title: span.embed.as_ref().and_then(|embed| embed.title.clone()),
            };
            let content = match &span.embed {
                Some(embed) => {
                    let pos = *positions.entry(&embed.path).or_insert_with(|| {
                        let pos = assets.len();
                        let (source, version, modified) = match load_asset(&embed.path) {
                            Ok(asset) => {
                                let version = asset
                                    .version
                                    .unwrap_or_else(|| file_version(asset.source.as_bytes()));
                                (Some(asset.source), Some(version), asset.modified)
                            }
                            Err(error) => {
                                problems.push(VaultProblem {
                                    code: error.code,
                                    path: embed.path.clone(),
                                    page_id: Some(path.to_owned()),
                                    block_id: Some(id.clone()),
                                    message: "Файл диаграммы недоступен".to_owned(),
                                });
                                (None, None, UNIX_EPOCH)
                            }
                        };
                        latest = latest.max(modified);
                        assets.push(VaultAsset {
                            path: embed.path.clone(),
                            kind: embed.kind,
                            source,
                            version,
                        });
                        pos
                    });
                    assets
                        .get(pos)
                        .and_then(|asset| asset.source.as_deref())
                        .unwrap_or_default()
                }
                None => source.get(span.content.clone()).unwrap_or_default(),
            };
            blocks.push(Block {
                id,
                page_id: path.to_owned(),
                kind: span.kind,
                source: content.to_owned(),
                title: projected.title.clone(),
                position,
                created_at: created_at.clone(),
                updated_at: String::new(),
                rendered_revision: None,
                render_ok: None,
                render_error: None,
            });
            public_spans.push(VaultSourceSpan {
                block_id: projected.id.clone(),
                kind: span.kind,
                from: projected.start,
                to: projected.end,
                source_from: projected.content_start,
                source_to: projected.content_end,
                asset_path: projected.asset_path.clone(),
            });
            spans.push(projected);
        }
        let updated_at = iso8601(latest);
        for block in &mut blocks {
            block.updated_at.clone_from(&updated_at);
        }
        let tokens = fingerprint(path, source, &assets);
        let page = PageFull {
            id: path.to_owned(),
            title: basename(path)
                .strip_suffix(extension(path))
                .unwrap_or_default()
                .to_owned(),
            revision: tokens.revision,
            created_at,
            updated_at,
            blocks,
        };
        let document = VaultDocument {
            page,
            path: path.to_owned(),
            source: source.to_owned(),
            version: tokens.version,
            spans: public_spans,
            aliases: syntax.aliases.clone(),
            tags: syntax.tags.clone(),
            assets,
            links: vec![],
            backlinks: vec![],
        };
        let links = syntax.links.clone();
        Self {
            document,
            spans,
            links,
            syntax,
            problems,
        }
    }
}

/// Разбирает подготовленный текст, которому ещё не назначены метки файловой системы.
///
/// # Errors
/// Возвращает диагностику, если исходный текст содержит конфликт Git.
pub fn parse_document(
    path: &str,
    source: &str,
    load_asset: impl FnMut(&str) -> Result<AssetRead, FileFailure>,
) -> Result<ParsedDocument, DocumentProblem> {
    ParsedDocument::parse(
        DocumentInput {
            path,
            source,
            times: FileTimes::default(),
        },
        load_asset,
    )
}
