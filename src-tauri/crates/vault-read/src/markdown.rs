use std::{
    collections::{HashMap, HashSet},
    ops::Range,
    sync::LazyLock,
};

use markdown::mdast::Node;

use crate::{
    markdown_blocks::{ByteSpan, Image, add_embed, complete_spans, fenced_content},
    offsets::Offsets,
};
use regex::Regex;

use crate::{
    BlockType, DocumentProblem, LinkKind, ProblemCode, VaultProblem,
    links::{LinkSpan, make_link},
    metadata::metadata,
    paths::{diagram_format, remote},
};

pub(crate) const JS_SPACE: &str =
    r"[\t\n\v\f\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

#[expect(clippy::expect_used, reason = "литералы проверяются тестами парсера")]
static CONFLICT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?mR)^<<<<<<<[^\r\n]*\r?\n[\s\S]*?^=======[ \t]*\r?\n[\s\S]*?^>>>>>>>[^\r\n]*$")
        .expect("регулярное выражение конфликта Git")
});
#[expect(clippy::expect_used, reason = "литерал проверяется тестами тегов")]
static TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:^|{JS_SPACE}|\()#([\p{{L}}\p{{N}}_-]+(?:/[\p{{L}}\p{{N}}_-]+)*)"
    ))
    .expect("выражение встроенных тегов")
});
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct Syntax {
    pub(crate) spans: Vec<ByteSpan>,
    pub(crate) problems: Vec<VaultProblem>,
    pub(crate) aliases: Vec<String>,
    pub(crate) tags: Vec<String>,
    pub(crate) prose: String,
    pub(crate) links: Vec<LinkSpan>,
}

pub(crate) fn parse(source: &str, path: &str) -> Result<Syntax, DocumentProblem> {
    if CONFLICT.is_match(source) {
        return Err(VaultProblem::document(
            ProblemCode::GitConflict,
            path,
            "Обнаружен конфликт Git",
        ));
    }
    let text = source.strip_prefix('\u{FEFF}').unwrap_or(source);
    let bom = source.len().saturating_sub(text.len());
    let root = markdown::to_mdast(text, &markdown::ParseOptions::default()).map_err(|error| {
        VaultProblem::document(ProblemCode::UnreadableFile, path, &error.to_string())
    })?;
    let mut nodes = Vec::new();
    walk(&root, &mut nodes);
    let prose = super::prose::extract(&root);
    let (aliases, mut tags) = metadata(source);
    tags.extend(
        TAG.captures_iter(&prose)
            .filter_map(|c| c.get(1).map(|m| m.as_str().to_owned())),
    );
    let mut seen = HashSet::new();
    tags.retain(|tag| seen.insert(tag.clone()));
    let mut syntax = Syntax {
        aliases,
        tags,
        prose,
        ..Syntax::default()
    };
    let offsets = Offsets::new(source);
    let mut definitions = HashMap::new();
    let mut excluded = Vec::new();
    for node in &nodes {
        let Some(range) = position(node, bom) else {
            continue;
        };
        match node {
            Node::Definition(def) => {
                definitions
                    .entry(def.identifier.as_str())
                    .or_insert((def.url.as_str(), range));
            }
            Node::Code(code) => {
                if code.lang.as_deref() == Some("mermaid")
                    && let Some(content) = fenced_content(source, &range)
                {
                    syntax.spans.push(ByteSpan {
                        kind: BlockType::Mermaid,
                        full: range.clone(),
                        content,
                        embed: None,
                    });
                }
                excluded.push(range);
            }
            Node::InlineCode(_) | Node::Html(_) => excluded.push(range),
            _ => (),
        }
    }
    let mut references = HashSet::new();
    for node in nodes {
        let Some(full) = position(node, bom) else {
            continue;
        };
        let url = match node {
            Node::Image(image) => {
                let token = token_at(source, &full, false);
                add_embed(
                    &mut syntax,
                    path,
                    &full,
                    Image {
                        url: &image.url,
                        title: Some(&image.alt),
                        token,
                    },
                );
                Some((image.url.as_str(), full, false))
            }
            Node::Link(link) => Some((link.url.as_str(), full, false)),
            Node::ImageReference(image) => {
                definitions
                    .get(image.identifier.as_str())
                    .and_then(|(url, definition)| {
                        if let Some(token) = token_at(source, definition, true) {
                            add_embed(
                                &mut syntax,
                                path,
                                &full,
                                Image {
                                    url,
                                    title: Some(&image.alt),
                                    token: Some(token),
                                },
                            );
                        }
                        references
                            .insert(image.identifier.as_str())
                            .then(|| (*url, definition.clone(), true))
                    })
            }
            Node::LinkReference(link) => {
                definitions
                    .get(link.identifier.as_str())
                    .and_then(|(url, definition)| {
                        references
                            .insert(link.identifier.as_str())
                            .then(|| (*url, definition.clone(), true))
                    })
            }
            _ => None,
        };
        if let Some((url, full, definition)) = url
            && !remote(url)
            && let Some(token) = token_at(source, &full, definition)
        {
            syntax.links.push(make_link(
                url,
                None,
                LinkKind::Markdown,
                (&offsets, token, full),
            ));
        }
    }
    super::wiki::collect(&mut syntax, path, (source, &excluded));
    syntax.links.sort_by_key(|link| link.start);
    syntax.spans = complete_spans(syntax.spans, source.len(), diagram_format(path));
    Ok(syntax)
}

fn walk<'a>(node: &'a Node, nodes: &mut Vec<&'a Node>) {
    nodes.push(node);
    if let Some(children) = node.children() {
        for child in children {
            walk(child, nodes);
        }
    }
}

fn position(node: &Node, bom: usize) -> Option<Range<usize>> {
    node.position()
        .map(|p| p.start.offset.saturating_add(bom)..p.end.offset.saturating_add(bom))
}

fn token_at(source: &str, full: &Range<usize>, definition: bool) -> Option<Range<usize>> {
    let raw = source.get(full.clone())?;
    let token = crate::paths::destination_token(raw, definition)?;
    Some(full.start.saturating_add(token.start)..full.start.saturating_add(token.end))
}
