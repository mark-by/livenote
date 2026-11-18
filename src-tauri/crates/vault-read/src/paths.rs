use std::{ops::Range, sync::LazyLock};

use percent_encoding::percent_decode_str;
use regex::Regex;

use crate::DiagramFormat;

#[expect(
    clippy::expect_used,
    reason = "валидное регулярное выражение для схемы URI"
)]
static SCHEME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.-]*:").expect("литерал регулярного выражения")
});

#[expect(clippy::expect_used, reason = "литералы проверяются тестами ссылок")]
static DEFINITION: LazyLock<Regex> = LazyLock::new(|| {
    let space = crate::markdown::JS_SPACE;
    Regex::new(&format!(r"^{space}*\[[^\]]+\]:{space}*")).expect("выражение определения ссылки")
});
#[expect(clippy::expect_used, reason = "литерал проверяется тестами поиска")]
pub(crate) static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("{}+", crate::markdown::JS_SPACE)).expect("выражение пробелов JavaScript")
});

pub(crate) fn destination_token(raw: &str, definition: bool) -> Option<Range<usize>> {
    let delimiter = if definition {
        DEFINITION.find(raw)?.end()
    } else {
        let mut depth = 0i32;
        let mut chars = raw.char_indices().peekable();
        loop {
            let (i, ch) = chars.next()?;
            match ch {
                '\\' => {
                    chars.next();
                }
                '[' => depth = depth.saturating_add(1),
                ']' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 && chars.peek().is_some_and(|(_, next)| *next == '(') {
                        break i.saturating_add(2);
                    }
                }
                _ => (),
            }
        }
    };
    let after = raw.get(delimiter..)?;
    let whitespace = WHITESPACE
        .find(after)
        .filter(|matched| matched.start() == 0)
        .map_or(0, |m| m.end());
    let mut start = delimiter.saturating_add(whitespace);
    let is_angled = raw.get(start..)?.starts_with('<');
    if is_angled {
        start = start.saturating_add(1);
    }
    let tail = raw.get(start..)?;
    let mut depth = 0i32;
    let mut chars = tail.char_indices();
    while let Some((at, ch)) = chars.next() {
        if ch == '\\' {
            chars.next();
        } else if (is_angled && ch == '>')
            || (!is_angled
                && ((ch == ')' && depth == 0) || WHITESPACE.is_match(ch.encode_utf8(&mut [0; 4]))))
        {
            return Some(start..start.saturating_add(at));
        } else if !is_angled {
            match ch {
                '(' => depth = depth.saturating_add(1),
                ')' => depth = depth.saturating_sub(1),
                _ => (),
            }
        }
    }
    Some(start..raw.len())
}

pub(crate) fn extension(path: &str) -> &str {
    let basename = basename(path);
    match basename.rfind('.') {
        Some(dot) if dot > 0 && basename != ".." => basename.get(dot..).unwrap_or_default(),
        _ => "",
    }
}

pub(crate) fn basename(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
}

/// Определяет формат по расширению POSIX-пути без учёта регистра.
#[must_use]
pub fn diagram_format(path: &str) -> Option<DiagramFormat> {
    match extension(path).to_ascii_lowercase().as_str() {
        ".mmd" | ".mermaid" => Some(DiagramFormat::Mermaid),
        ".bpmn" => Some(DiagramFormat::Bpmn),
        ".drawio" => Some(DiagramFormat::Drawio),
        _ => None,
    }
}

/// Проверяет, есть ли у видимого файла проекция документа.
#[must_use]
pub fn openable(path: &str) -> bool {
    path.ends_with(".md") || diagram_format(path).is_some()
}

pub(crate) fn remote(target: &str) -> bool {
    target.starts_with("//") || SCHEME.is_match(target)
}

/// Преобразует цель Markdown в относительный путь. Файловую систему не проверяет.
pub(crate) fn destination(note_path: &str, target: &str) -> Result<String, &'static str> {
    let bytes = target.as_bytes();
    for (at, _) in target.match_indices('%') {
        if !bytes
            .get(at + 1..at + 3)
            .is_some_and(|pair| pair.iter().all(u8::is_ascii_hexdigit))
        {
            return Err("Некорректное кодирование пути");
        }
    }
    let decoded = percent_decode_str(target)
        .decode_utf8()
        .map_err(|_| "Некорректное кодирование пути")?;
    if decoded.contains(['\0', '\\']) || decoded.starts_with('/') || SCHEME.is_match(&decoded) {
        return Err("Небезопасный путь диаграммы");
    }
    let base = note_path.rsplit_once('/').map_or("", |(dir, _)| dir);
    let target = decoded
        .split_once('#')
        .map_or(decoded.as_ref(), |(file, _)| file);
    let mut parts = Vec::new();
    for part in base.split('/').chain(target.split('/')) {
        match part {
            "" | "." => (),
            ".." if parts.last().is_some_and(|part| *part != "..") => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    if parts.first() == Some(&"..")
        || parts
            .iter()
            .any(|part| matches!(*part, ".git" | ".livenote"))
    {
        return Err("Путь выходит за пределы vault");
    }
    if parts.is_empty() {
        return Ok(if target.ends_with('/') { "./" } else { "." }.to_owned());
    }
    let mut path = parts.join("/");
    if target.ends_with('/') {
        path.push('/');
    }
    Ok(path)
}
