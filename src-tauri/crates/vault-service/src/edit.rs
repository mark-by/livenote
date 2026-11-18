use std::{collections::HashSet, ops::Range, path::Path};

use unicode_normalization::UnicodeNormalization;
use vault_read::{BlockSpan, BlockType, ParsedDocument, Utf16Offset};

use crate::ApiError;

pub fn byte_at(source: &str, offset: Utf16Offset) -> Result<usize, ApiError> {
    let mut seen = 0usize;
    for (byte, c) in source.char_indices() {
        if seen == offset.0 {
            return Ok(byte);
        }
        seen = seen.saturating_add(c.len_utf16());
        if seen > offset.0 {
            break;
        }
    }
    if seen == offset.0 {
        Ok(source.len())
    } else {
        Err(ApiError::invalid(
            "Смещение не соответствует границе символа UTF-16",
        ))
    }
}

pub fn byte_range(
    source: &str,
    from: Utf16Offset,
    to: Utf16Offset,
) -> Result<Range<usize>, ApiError> {
    let range = byte_at(source, from)?..byte_at(source, to)?;
    if range.start > range.end {
        return Err(ApiError::invalid("Некорректный диапазон блока"));
    }
    Ok(range)
}

pub fn excerpt<'a>(source: &'a str, span: &BlockSpan) -> Result<&'a str, ApiError> {
    source
        .get(byte_range(source, span.start, span.end)?)
        .ok_or_else(|| ApiError::invalid("Некорректный диапазон блока"))
}

pub fn reorder(
    doc: &ParsedDocument,
    deleted: &[String],
    order: Option<&[String]>,
) -> Result<String, ApiError> {
    for id in deleted {
        if !doc.spans().iter().any(|span| &span.id == id) {
            return Err(ApiError::block(&doc.document().path, id));
        }
    }
    let remaining = doc
        .spans()
        .iter()
        .filter(|span| !deleted.contains(&span.id))
        .collect::<Vec<_>>();
    let ordered = if let Some(order) = order {
        if order.len() != remaining.len()
            || order.iter().collect::<HashSet<_>>().len() != order.len()
        {
            return Err(ApiError::invalid("Некорректный blockOrder"));
        }
        order
            .iter()
            .map(|id| {
                remaining
                    .iter()
                    .find(|span| &span.id == id)
                    .copied()
                    .ok_or_else(|| ApiError::invalid("Некорректный blockOrder"))
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        remaining
    };
    if deleted.is_empty() && ordered.iter().copied().eq(doc.spans()) {
        return Ok(doc.source().to_owned());
    }
    let source = doc.source();
    let mut next = String::with_capacity(source.len());
    let spans = doc.spans();
    let mut previous_end = 0;
    for (slot, selected) in spans.iter().zip(&ordered) {
        let position = byte_range(source, slot.start, slot.end)?;
        if let Some(gap) = source.get(previous_end..position.start) {
            next.push_str(gap);
        }
        let value = excerpt(source, selected)?;
        if !next.is_empty()
            && !next.ends_with(['\n', '\u{feff}'])
            && selected.kind != BlockType::Markdown
        {
            next.push_str(doc.newline());
        }
        next.push_str(value);
        previous_end = position.end;
    }
    for slot in spans.iter().skip(ordered.len()) {
        let position = byte_range(source, slot.start, slot.end)?;
        if let Some(gap) = source.get(previous_end..position.start) {
            next.push_str(gap);
        }
        previous_end = position.end;
    }
    if let Some(tail) = source.get(previous_end..) {
        next.push_str(tail);
    }
    Ok(next)
}

pub fn safe_title(title: &str) -> String {
    let title = if title.trim().is_empty() {
        "Без названия"
    } else {
        title.trim()
    };
    let safe = title
        .nfc()
        .map(|c| if "\\/:*?\"<>|\0".contains(c) { '-' } else { c })
        .collect::<String>();
    let mut utf16 = 0usize;
    let name = safe
        .trim_matches(|c: char| c.is_whitespace() || c == '.')
        .chars()
        .take_while(|c| {
            utf16 = utf16.saturating_add(c.len_utf16());
            utf16 <= 120
        })
        .collect::<String>();
    if name.is_empty() {
        "Заметка".to_owned()
    } else {
        name
    }
}

pub fn renamed(path: &str, title: &str) -> String {
    let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
    let ext = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    let name = format!("{}.{ext}", safe_title(title));
    if parent.is_empty() {
        name
    } else {
        format!("{parent}/{name}")
    }
}

pub fn fence(source: &str, title: Option<&str>, nl: &str) -> String {
    let normalized = source.replace("\r\n", "\n").replace('\n', nl);
    let ticks = "`".repeat(
        normalized
            .split(|c| c != '`')
            .map(str::len)
            .max()
            .unwrap_or(0)
            .saturating_add(1)
            .max(3),
    );
    let heading = title
        .filter(|title| !title.is_empty())
        .map_or_else(String::new, |title| format!("## {title}{nl}"));
    let separator = if normalized.ends_with(nl) { "" } else { nl };
    format!("{heading}{ticks}mermaid{nl}{normalized}{separator}{ticks}{nl}")
}

pub fn escape_label(label: &str) -> String {
    let mut result = String::new();
    for char in label.chars() {
        if matches!(char, '[' | ']' | '\\') {
            result.push('\\');
        }
        result.push(char);
    }
    result
}
