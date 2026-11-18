use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    ops::Range,
    sync::{Arc, LazyLock},
};

use icu_collator::{Collator, CollatorBorrowed};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::{
    LinkKind, ParsedDocument, Utf16Offset, VaultBacklink, VaultDocument, VaultLink, markdown,
    offsets::Offsets,
    paths::{destination, extension},
};

/// Ссылка и исходные диапазоны в единицах UTF-16.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSpan {
    #[serde(flatten)]
    pub link: VaultLink,
    pub start: Utf16Offset,
    pub end: Utf16Offset,
    pub full_start: Utf16Offset,
    pub full_end: Utf16Offset,
}

pub(crate) fn make_link(
    url: &str,
    label: Option<&str>,
    kind: LinkKind,
    ranges: (&Offsets, Range<usize>, Range<usize>),
) -> LinkSpan {
    let (offsets, token, full) = ranges;
    let (target, fragment) = url
        .split_once('#')
        .map_or((url, None), |(target, fragment)| {
            (target, Some(fragment.to_owned()))
        });
    LinkSpan {
        link: VaultLink {
            target: target.to_owned(),
            target_page_id: None,
            label: label.map(str::to_owned),
            kind,
            fragment,
        },
        start: offsets.at(token.start),
        end: offsets.at(token.end),
        full_start: offsets.at(full.start),
        full_end: offsets.at(full.end),
    }
}

/// Извлекает ссылки и диапазоны без доступа к файлам.
///
/// # Errors
/// Возвращает диагностику конфликта Git.
pub fn link_spans(source: &str) -> Result<Vec<LinkSpan>, crate::DocumentProblem> {
    markdown::parse(source, "").map(|syntax| syntax.links)
}

pub(crate) fn folded(value: &str) -> String {
    value
        .nfc()
        .flat_map(char::to_lowercase)
        .map(|ch| if ch == 'ς' { 'σ' } else { ch })
        .collect()
}

pub(crate) fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

pub(crate) fn locale_cmp(a: &str, b: &str) -> Ordering {
    #[expect(clippy::expect_used, reason = "корневые данные ICU встроены в крейт")]
    static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
        Collator::try_new(Default::default(), Default::default()).expect("корневая сортировка ICU")
    });
    COLLATOR.compare(a, b)
}

struct Resolver<'a> {
    files: HashSet<&'a str>,
    names: HashMap<String, Option<&'a str>>,
}

impl<'a> Resolver<'a> {
    fn new(pages: impl IntoIterator<Item = &'a VaultDocument>, paths: &'a [String]) -> Self {
        let files = paths.iter().map(String::as_str).collect();
        let mut names = HashMap::new();
        for page in pages {
            for name in std::iter::once(&page.page.title)
                .chain(&page.aliases)
                .map(|name| folded(name))
                .collect::<HashSet<_>>()
            {
                names
                    .entry(name)
                    .and_modify(|value| *value = None)
                    .or_insert(Some(page.path.as_str()));
            }
        }
        Self { files, names }
    }

    fn resolve(&self, path: &str, spans: &[LinkSpan]) -> Vec<LinkSpan> {
        spans
            .iter()
            .cloned()
            .map(|mut span| {
                let link = &mut span.link;
                link.target_page_id = self.target(path, link);
                span
            })
            .collect()
    }

    fn target(&self, path: &str, link: &VaultLink) -> Option<String> {
        if link.target.is_empty() {
            return Some(path.to_owned());
        }
        let relative = destination(path, &link.target).ok()?;
        match link.kind {
            LinkKind::Markdown => self
                .files
                .get(relative.as_str())
                .map(|&value| value.to_owned()),
            LinkKind::Wiki => {
                let candidate = if extension(&relative).is_empty() {
                    let relative_md = relative.clone() + ".md";
                    let root_md = destination("root.md", &link.target).unwrap_or(relative) + ".md";
                    self.files
                        .get(relative_md.as_str())
                        .or_else(|| self.files.get(root_md.as_str()))
                } else {
                    self.files.get(relative.as_str())
                };
                candidate
                    .copied()
                    .or_else(|| self.names.get(&folded(&link.target)).copied().flatten())
                    .map(str::to_owned)
            }
        }
    }
}

/// Назначает ссылки документа по списку видимых путей и псевдонимам документов.
#[must_use]
pub fn resolve_links(
    document: &ParsedDocument,
    pages: &[&VaultDocument],
    paths: &[String],
) -> Vec<LinkSpan> {
    Resolver::new(pages.iter().copied(), paths).resolve(&document.document().path, document.links())
}

pub(crate) fn populate(pages: &mut [Arc<ParsedDocument>], paths: &[String]) {
    let resolver = Resolver::new(pages.iter().map(|page| page.document()), paths);
    let documents: HashSet<_> = pages.iter().map(|p| p.document().path.as_str()).collect();
    let mut backlinks: HashMap<String, Vec<VaultBacklink>> = HashMap::new();
    let mut resolved = Vec::with_capacity(pages.len());
    for page in pages.iter() {
        let doc = page.document();
        let links = resolver.resolve(&doc.path, page.links());
        let targets: HashSet<_> = links
            .iter()
            .filter_map(|span| span.link.target_page_id.as_deref())
            .collect();
        for target in targets {
            if target != doc.path && documents.contains(target) {
                backlinks
                    .entry(target.to_owned())
                    .or_default()
                    .push(VaultBacklink {
                        page_id: doc.path.clone(),
                        title: doc.page.title.clone(),
                        path: doc.path.clone(),
                    });
            }
        }
        resolved.push(links);
    }
    for (page, links) in pages.iter_mut().zip(resolved) {
        let mut incoming = backlinks.remove(&page.document().path).unwrap_or_default();
        incoming.sort_by(|a, b| locale_cmp(&a.path, &b.path));
        if page.links() != links
            || page.document().links.len() != links.len()
            || page.document().backlinks != incoming
        {
            Arc::make_mut(page).set_graph(links, incoming);
        }
    }
}
