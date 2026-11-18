use crate::{
    LinkKind,
    links::make_link,
    markdown::Syntax,
    markdown_blocks::{Image, add_embed},
    offsets::Offsets,
};
use regex::Regex;
use std::{ops::Range, sync::LazyLock};

#[expect(clippy::expect_used, reason = "литерал проверяется тестами парсера")]
static WIKI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]\r\n]+)\]\]").expect("выражение wiki"));
pub(crate) fn collect(
    syntax: &mut Syntax,
    path: &str,
    (source, excluded): (&str, &[Range<usize>]),
) {
    let offsets = Offsets::new(source);
    for capture in WIKI.captures_iter(source) {
        let (Some(raw), Some(inner)) = (capture.get(0), capture.get(1)) else {
            continue;
        };
        let at = raw.start();
        let prefix = source.get(..at).unwrap_or_default();
        let (before, bang) = prefix
            .strip_suffix('!')
            .map_or((prefix, false), |before| (before, true));
        if before.bytes().rev().take_while(|&b| b == b'\\').count() % 2 != 0 {
            continue;
        }
        let (target, label) = inner
            .as_str()
            .split_once('|')
            .map_or((inner.as_str(), None), |(target, label)| {
                (target, Some(label))
            });
        let end = raw.end();
        let target_start = inner.start();
        let token = target_start..target_start.saturating_add(target.len());
        let inside = |at| excluded.iter().any(|range| range.contains(&at));
        if !inside(at) {
            syntax.links.push(make_link(
                target,
                label,
                LinkKind::Wiki,
                (&offsets, token.clone(), at..end),
            ));
        }
        let embed_at = at.saturating_sub(1);
        if bang && !inside(embed_at) {
            add_embed(
                syntax,
                path,
                &(embed_at..end),
                Image {
                    url: target,
                    title: label,
                    token: Some(token),
                },
            );
        }
    }
}
