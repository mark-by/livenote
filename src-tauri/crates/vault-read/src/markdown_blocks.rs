use crate::{
    BlockType, DiagramFormat, ProblemCode, VaultProblem,
    markdown::Syntax,
    paths::{destination, diagram_format, remote},
};
use regex::Regex;
use std::{ops::Range, sync::LazyLock};

#[expect(clippy::expect_used, reason = "литерал проверяется тестами ограждений")]
static FENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^ {0,3}(`{3,}|~{3,})mermaid[^\r\n]*\r?\n").expect("выражение начала Mermaid")
});

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct ByteSpan {
    pub(crate) kind: BlockType,
    pub(crate) full: Range<usize>,
    pub(crate) content: Range<usize>,
    pub(crate) embed: Option<Embed>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Embed {
    pub(crate) path: String,
    pub(crate) kind: DiagramFormat,
    pub(crate) title: Option<String>,
    pub(crate) destination: Option<Range<usize>>,
}

pub(crate) struct Image<'a> {
    pub(crate) url: &'a str,
    pub(crate) title: Option<&'a str>,
    pub(crate) token: Option<Range<usize>>,
}

pub(crate) fn add_embed(syntax: &mut Syntax, path: &str, full: &Range<usize>, image: Image<'_>) {
    if remote(image.url) {
        return;
    }
    let target = match destination(path, image.url) {
        Ok(target) => target,
        Err(message) => {
            syntax.problems.push(VaultProblem::document(
                ProblemCode::UnsafePath,
                path,
                message,
            ));
            return;
        }
    };
    if let Some(kind) = diagram_format(&target) {
        syntax.spans.push(ByteSpan {
            kind: kind.into(),
            full: full.clone(),
            content: full.clone(),
            embed: Some(Embed {
                kind,
                path: target,
                title: image.title.map(str::to_owned),
                destination: image.token,
            }),
        });
    }
}

pub(crate) fn fenced_content(source: &str, full: &Range<usize>) -> Option<Range<usize>> {
    let raw = source.get(full.clone())?;
    let opening = FENCE.captures(raw)?;
    let content_start = opening.get(0)?.end();
    let fence = opening.get(1)?.as_str();
    let sigil = fence.as_bytes().first().copied()?;
    let rest = raw.get(content_start..)?;
    let mut at = 0usize;
    for line in rest.split_inclusive(['\n', '\r', '\u{2028}', '\u{2029}']) {
        let trimmed = line.trim_start_matches(' ');
        let width = trimmed.bytes().take_while(|ch| *ch == sigil).count();
        if line.len().saturating_sub(trimmed.len()) <= 3
            && width >= fence.len()
            && trimmed
                .get(width..)?
                .trim_end_matches(['\n', '\r', '\u{2028}', '\u{2029}'])
                .trim_matches([' ', '\t'])
                .is_empty()
        {
            let previous = rest.get(..at)?;
            let length = previous
                .strip_suffix("\r\n")
                .or_else(|| previous.strip_suffix('\n'))
                .unwrap_or(previous)
                .len();
            return Some(
                full.start.saturating_add(content_start)
                    ..full
                        .start
                        .saturating_add(content_start)
                        .saturating_add(length),
            );
        }
        at = at.saturating_add(line.len());
    }
    Some(full.start.saturating_add(content_start)..full.end)
}

pub(crate) fn complete_spans(
    mut candidates: Vec<ByteSpan>,
    length: usize,
    standalone: Option<DiagramFormat>,
) -> Vec<ByteSpan> {
    let plain = |kind, range: Range<usize>| ByteSpan {
        kind,
        full: range.clone(),
        content: range,
        embed: None,
    };
    if let Some(kind) = standalone {
        return vec![plain(kind.into(), 0..length)];
    }
    candidates.sort_by_key(|span| span.full.start);
    let mut output = Vec::new();
    let mut cursor = 0;
    for candidate in candidates {
        if candidate.full.start < cursor {
            continue;
        }
        if cursor < candidate.full.start {
            output.push(plain(BlockType::Markdown, cursor..candidate.full.start));
        }
        cursor = candidate.full.end;
        output.push(candidate);
    }
    if cursor < length {
        output.push(plain(BlockType::Markdown, cursor..length));
    }
    output
}
