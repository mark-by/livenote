use std::{collections::BTreeMap, num::NonZeroUsize, ops::Range};

use uuid::Uuid;
use vault_read::{Utf16Offset, VaultLink, file_version};

use crate::{ApiError, edit::byte_range, state::State};

use super::{
    Cite, CiteKind, Fragment, Hit, Lines, NavigationTarget, Patch, Query, Read, ReadId, topic,
};

pub(super) const MAX_SOURCE: usize = 2 * 1024 * 1024;

pub(super) fn check_size(size: usize) -> Result<(), ApiError> {
    if size > MAX_SOURCE {
        return Err(ApiError::invalid("Превышен лимит размера исходника"));
    }
    Ok(())
}

pub(super) struct Reading {
    pub path: String,
    pub version: String,
    pub range: Range<usize>,
}

pub(super) fn read(
    path: &str,
    source: &str,
    lines: Lines,
    target: NavigationTarget,
) -> Result<(Read, Reading), ApiError> {
    let Lines { first, last } = lines;
    if first == 0 || last < first || last - first >= 200 {
        return Err(ApiError::invalid("Некорректный диапазон строк"));
    }
    let mut starts =
        std::iter::once(0).chain(source.match_indices('\n').map(|(index, _)| index + 1));
    let start = starts
        .nth(first - 1)
        .ok_or_else(|| ApiError::invalid("Начальная строка за пределами файла"))?;
    let end = starts.nth(last - first).map_or(source.len(), |next| {
        let end = next - 1;
        if source.as_bytes().get(end.wrapping_sub(1)) == Some(&b'\r') {
            end - 1
        } else {
            end
        }
    });
    let prefix = source
        .get(..start)
        .ok_or_else(|| ApiError::invalid("Некорректная строка"))?;
    let text = source
        .get(start..end)
        .ok_or_else(|| ApiError::invalid("Некорректная строка"))?;
    if text.len() > 64 * 1024 {
        return Err(ApiError::invalid("Фрагмент превышает лимит чтения"));
    }
    let offset = prefix.encode_utf16().count();
    let version = file_version(source.as_bytes());
    let reading = Reading {
        path: path.to_owned(),
        version: version.clone(),
        range: offset..offset + text.encode_utf16().count(),
    };
    let fragment = Fragment {
        cite: cite(path, first),
        text: text.to_owned(),
    };
    Ok((
        Read {
            read_id: ReadId(Uuid::new_v4()),
            version,
            offset,
            fragment,
            target,
        },
        reading,
    ))
}

pub(super) fn line_after(prefix: &str) -> NonZeroUsize {
    NonZeroUsize::MIN.saturating_add(prefix.bytes().filter(|&byte| byte == b'\n').count())
}

pub(super) fn patch(
    source: &str,
    read: &Reading,
    edits: &[Patch],
) -> Result<(String, Option<NonZeroUsize>), ApiError> {
    if file_version(source.as_bytes()) != read.version {
        return Err(
            ApiError::new(409, "conflict", "Перечитайте изменённый снимок")
                .details(serde_json::json!({"paths":[read.path]})),
        );
    }
    if edits.is_empty() || edits.len() > 128 {
        return Err(ApiError::invalid("Некорректное количество правок"));
    }
    let mut ordered = edits.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|edit| (edit.from, edit.to));
    let mut result = String::new();
    let mut cursor = 0;
    let mut previous = None;
    let mut line = None;
    for edit in ordered {
        if edit.from < read.range.start || edit.to > read.range.end || previous == Some(edit.from) {
            return Err(ApiError::invalid(
                "Правки пересекаются или выходят за пределы чтения",
            ));
        }
        let range = byte_range(source, Utf16Offset(edit.from), Utf16Offset(edit.to))?;
        let untouched = source
            .get(cursor..range.start)
            .ok_or_else(|| ApiError::invalid("Правки пересекаются"))?;
        if source.get(range.clone()) != Some(&edit.old) {
            return Err(ApiError::invalid(
                "Поле old не совпадает с прочитанным текстом",
            ));
        }
        if line.is_none() {
            line = Some(line_after(untouched));
        }
        check_size(
            result
                .len()
                .saturating_add(untouched.len())
                .saturating_add(edit.text.len()),
        )?;
        result.push_str(untouched);
        result.push_str(&edit.text);
        cursor = range.end;
        previous = Some(edit.from);
    }
    let tail = source
        .get(cursor..)
        .ok_or_else(|| ApiError::invalid("Некорректный диапазон"))?;
    check_size(result.len() + tail.len())?;
    result.push_str(tail);
    Ok((result, line))
}

pub(super) fn search<'a>(
    files: impl Iterator<Item = SearchDocument<'a>>,
    query: &Query,
) -> Result<Vec<Hit>, ApiError> {
    let terms = query
        .text
        .split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    if terms.is_empty() || query.text.len() > 1024 || !(1..=50).contains(&query.limit) {
        return Err(ApiError::invalid("Некорректный запрос поиска"));
    }
    let topic = match terms.as_slice() {
        [term] if query.text.trim().chars().all(char::is_alphanumeric) => Some(term.as_str()),
        _ => None,
    };
    let mut ranked = Vec::new();
    let mut hits = Vec::new();
    let mut budget = 16 * MAX_SOURCE;
    for doc in files.take(16_384) {
        let SearchDocument { path, source, .. } = doc;
        if source.len() > MAX_SOURCE {
            continue;
        }
        let Some(rest) = budget.checked_sub(source.len()) else {
            break;
        };
        budget = rest;
        if let Some(rank) = topic.and_then(|term| topic::Rank::of(path, term)) {
            if !source.trim().is_empty() {
                ranked.push((rank, doc));
            }
        } else {
            hits.extend(
                matching_lines(source, &terms)
                    .take(query.limit - hits.len())
                    .map(|(index, line)| (path, index, line)),
            );
            if topic.is_none() && hits.len() == query.limit {
                break;
            }
        }
    }
    topic::order(&mut ranked);
    Ok(ranked
        .into_iter()
        .filter_map(|(_, doc)| {
            let (index, line) = matching_lines(doc.source, &terms).next().or_else(|| {
                doc.source
                    .lines()
                    .enumerate()
                    .find(|(_, line)| !line.trim().is_empty())
            })?;
            Some((doc.path, index, line))
        })
        .chain(hits)
        .take(query.limit)
        .map(|(path, index, line)| Hit {
            reference: Uuid::new_v4(),
            cite: cite(path, index + 1),
            excerpt: line.chars().take(400).collect(),
        })
        .collect())
}

fn matching_lines<'a>(source: &'a str, terms: &[String]) -> impl Iterator<Item = (usize, &'a str)> {
    source.lines().enumerate().filter(|(_, line)| {
        let lower = line.to_lowercase();
        terms.iter().all(|term| lower.contains(term))
    })
}

#[derive(Clone, Copy)]
pub(super) struct SearchDocument<'a> {
    pub(super) path: &'a str,
    source: &'a str,
    pub(super) links: &'a [VaultLink],
}

pub(super) fn documents<'a>(
    state: &'a State,
    captured: &'a BTreeMap<String, String>,
) -> impl Iterator<Item = SearchDocument<'a>> {
    captured
        .iter()
        .map(|(path, source)| SearchDocument {
            path,
            source,
            links: &[],
        })
        .chain(state.projection.documents().filter_map(|doc| {
            let doc = doc.document();
            (!captured.contains_key(&doc.path)).then_some(SearchDocument {
                path: &doc.path,
                source: &doc.source,
                links: &doc.links,
            })
        }))
}

pub(super) fn relative_to<'a>(path: &'a str, folder: &str) -> Option<&'a str> {
    if folder.is_empty() {
        Some(path)
    } else {
        path.strip_prefix(folder)?.strip_prefix('/')
    }
}

pub(super) fn discover(
    state: &State,
    captured: &BTreeMap<String, String>,
    folder: &str,
    focused: Option<&str>,
) -> Vec<Hit> {
    const MAX_FILES: usize = 6;
    const MAX_INDEX: usize = 16_384;
    let mut files = BTreeMap::new();
    for SearchDocument { path, source, .. } in documents(state, captured).take(MAX_INDEX) {
        let Some(relative) = relative_to(path, folder) else {
            continue;
        };
        let name = relative.rsplit('/').next().unwrap_or(relative);
        let rank = if Some(path) == focused {
            0
        } else if name.eq_ignore_ascii_case("readme.md") || name.eq_ignore_ascii_case("index.md") {
            1
        } else if name != "AGENTS.md" && name.ends_with(".md") {
            2
        } else {
            continue;
        };
        if source.is_empty() {
            continue;
        }
        let depth = relative.bytes().filter(|&byte| byte == b'/').count();
        files.insert((rank, depth, path), source);
        if files.len() > MAX_FILES {
            files.pop_last();
        }
    }
    files
        .into_iter()
        .filter_map(|((_, _, path), source)| {
            let excerpt: String = source.chars().take(1800).collect();
            (!excerpt.trim().is_empty()).then(|| Hit {
                reference: Uuid::new_v4(),
                cite: cite(path, 1),
                excerpt,
            })
        })
        .collect()
}

fn cite(path: &str, line: usize) -> Cite {
    Cite {
        kind: CiteKind::Vault,
        path: path.to_owned(),
        line,
    }
}
