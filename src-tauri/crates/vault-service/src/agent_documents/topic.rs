use std::{
    cmp::Reverse,
    collections::{BTreeMap, BTreeSet},
};

use vault_read::{LinkKind, VaultLink};

use super::text::SearchDocument;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Rank<'a> {
    ExactStem,
    ExactFolder { depth: usize, folder: &'a str },
    Token,
}

impl<'a> Rank<'a> {
    pub(super) fn of(path: &'a str, term: &str) -> Option<Self> {
        let (dirs, name) = path.rsplit_once('/').unwrap_or(("", path));
        let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
        if stem.to_lowercase() == term {
            return Some(Self::ExactStem);
        }
        let mut folder = dirs;
        let mut depth = 0;
        while !folder.is_empty() {
            let (parent, segment) = folder.rsplit_once('/').unwrap_or(("", folder));
            if segment.to_lowercase() == term {
                return Some(Self::ExactFolder { depth, folder });
            }
            folder = parent;
            depth += 1;
        }
        [dirs, stem]
            .into_iter()
            .any(|part| {
                part.to_lowercase()
                    .split(|ch: char| !ch.is_alphanumeric())
                    .any(|word| word == term)
            })
            .then_some(Self::Token)
    }
}

#[derive(Default)]
struct Overview<'a> {
    path: &'a str,
    targets: BTreeMap<&'a str, usize>,
}

pub(super) fn order<'a>(matches: &mut [(Rank<'a>, SearchDocument<'a>)]) {
    let mut overviews: BTreeMap<_, Overview<'_>> = BTreeMap::new();
    let direct_paths: BTreeSet<_> = matches
        .iter()
        .filter_map(|(rank, doc)| {
            matches!(rank, Rank::ExactFolder { depth: 0, .. }).then_some(doc.path)
        })
        .collect();
    for &(rank, doc) in matches.iter() {
        let Rank::ExactFolder { depth: 0, folder } = rank else {
            continue;
        };
        let mut targets = BTreeMap::new();
        for (position, link) in doc.links.iter().enumerate() {
            if let Some(target) = sibling_target(link, folder, &direct_paths)
                && target != doc.path
            {
                targets.entry(target).or_insert(position);
            }
        }
        let overview = overviews.entry(folder).or_default();
        // Обзор связывает больше соседних заметок; порядок ссылок задаёт автор.
        if (Reverse(targets.len()), doc.path) < (Reverse(overview.targets.len()), overview.path)
            || overview.path.is_empty()
        {
            *overview = Overview {
                path: doc.path,
                targets,
            };
        }
    }
    matches.sort_unstable_by_key(|&(rank, doc)| {
        let tier = match rank {
            Rank::ExactStem => (0, 0),
            Rank::ExactFolder { depth, .. } => (1, depth),
            Rank::Token => (2, 0),
        };
        let placement = if let Rank::ExactFolder { depth: 0, folder } = rank
            && let Some(overview) = overviews.get(folder)
        {
            (
                doc.path != overview.path,
                overview
                    .targets
                    .get(doc.path)
                    .copied()
                    .unwrap_or(usize::MAX),
                Reverse(overview.targets.len()),
            )
        } else {
            (true, usize::MAX, Reverse(0))
        };
        (tier, placement, doc.path)
    });
}

fn sibling_target<'a>(
    link: &VaultLink,
    folder: &str,
    direct_paths: &BTreeSet<&'a str>,
) -> Option<&'a str> {
    if let Some(target) = link.target_page_id.as_deref() {
        return (parent(target) == folder)
            .then(|| direct_paths.get(target).copied())
            .flatten();
    }
    // В Wiki-ссылке из таблицы парсер оставляет экранирование перед псевдонимом.
    if link.kind != LinkKind::Wiki || link.label.is_none() {
        return None;
    }
    let name = link.target.strip_suffix('\\')?;
    if name.is_empty() || name.contains(['/', '\\']) {
        return None;
    }
    let path = format!("{folder}/{name}");
    direct_paths
        .get(path.as_str())
        .or_else(|| direct_paths.get(format!("{path}.md").as_str()))
        .copied()
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| folder)
}
