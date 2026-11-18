use std::collections::BTreeMap;

use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use vault_read::{LinkKind, ParsedDocument, VaultDocument, resolve_links};

use crate::{ApiError, edit::byte_range};

#[derive(Clone, Copy)]
pub struct UrlStyle<'a> {
    kind: LinkKind,
    raw: &'a str,
    angled: bool,
}

impl Default for UrlStyle<'_> {
    fn default() -> Self {
        Self {
            kind: LinkKind::Markdown,
            raw: "",
            angled: false,
        }
    }
}

pub fn relative_url(from: &str, to: &str, style: UrlStyle<'_>) -> String {
    let base = from.rsplit_once('/').map_or("", |(parent, _)| parent);
    let mut base = base.split('/').filter(|item| !item.is_empty()).peekable();
    let mut target = to.split('/').peekable();
    while base.peek().is_some() && base.peek() == target.peek() {
        base.next();
        target.next();
    }
    let path = std::iter::repeat_n("..", base.count())
        .chain(target)
        .collect::<Vec<_>>()
        .join("/");
    let path = if path.is_empty() {
        to.rsplit('/').next().unwrap_or(to)
    } else {
        &path
    };
    let decoded = percent_decode_str(style.raw).decode_utf8_lossy();
    let encode_unicode = style.raw.is_ascii() && !decoded.is_ascii();
    let mut output = String::with_capacity(path.len());
    if style.raw.starts_with("./") && !path.starts_with("../") {
        output.push_str("./");
    }
    for ch in path.chars() {
        if ch == '/' {
            output.push(ch);
            continue;
        }
        let escaped = matches!(ch, '(' | ')' | '[' | ']' | '<' | '>' | '\\')
            && style.kind == LinkKind::Markdown
            && style.raw.contains(&format!("\\{ch}"));
        if escaped {
            output.push('\\');
            output.push(ch);
            continue;
        }
        let unsafe_char = match style.kind {
            LinkKind::Wiki => "%#?|[]\\".contains(ch) || ch.is_ascii_control(),
            LinkKind::Markdown if style.angled => "%#?<>".contains(ch) || ch.is_ascii_control(),
            LinkKind::Markdown => {
                "%#?()[]<>\"'`\\".contains(ch) || ch.is_whitespace() || ch.is_ascii_control()
            }
        };
        let mut buf = [0; 4];
        let char_text = ch.encode_utf8(&mut buf);
        let preserve_encoded = decoded.contains(&*char_text) && !style.raw.contains(&*char_text);
        if unsafe_char || preserve_encoded || (encode_unicode && !ch.is_ascii()) {
            output.push_str(&utf8_percent_encode(char_text, NON_ALPHANUMERIC).to_string());
        } else {
            output.push(ch);
        }
    }
    output
}

pub fn rewrite(
    doc: &ParsedDocument,
    graph: (&[&VaultDocument], &[String]),
    mapping: &BTreeMap<String, String>,
) -> Result<String, ApiError> {
    let from = &doc.document().path;
    let next_path = mapping.get(from).unwrap_or(from);
    let source = doc.source();
    let mut result = source.to_owned();
    for link in resolve_links(doc, graph.0, graph.1).into_iter().rev() {
        if link.link.target.is_empty() {
            continue;
        }
        let embedded = (next_path != from)
            .then(|| {
                doc.spans()
                    .iter()
                    .find(|span| span.destination_start == Some(link.start))
                    .and_then(|span| span.asset_path.as_ref())
            })
            .flatten();
        let Some(target) = link.link.target_page_id.as_ref().or(embedded) else {
            continue;
        };
        let next_target = mapping.get(target).unwrap_or(target);
        if next_path == from && next_target == target {
            continue;
        }
        let range = byte_range(source, link.start, link.end)?;
        let raw = source
            .get(range.clone())
            .ok_or_else(|| ApiError::invalid("Некорректный диапазон ссылки"))?;
        let angled = source.as_bytes().get(range.start.saturating_sub(1)) == Some(&b'<');
        let mut value = relative_url(
            next_path,
            next_target,
            UrlStyle {
                kind: link.link.kind,
                raw,
                angled,
            },
        );
        if let Some(fragment) = &link.link.fragment {
            value.push('#');
            value.push_str(fragment);
        }
        if link.link.kind == LinkKind::Wiki && link.link.label.is_none() {
            value.push('|');
            value.push_str(&link.link.target);
        }
        result.replace_range(range, &value);
    }
    Ok(result)
}
