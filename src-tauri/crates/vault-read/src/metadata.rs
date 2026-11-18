use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

use regex::Regex;
use yaml_rust2::{
    parser::{Event, Parser, Tag},
    scanner::TScalarStyle,
};

#[expect(clippy::expect_used, reason = "литерал проверяется тестами метаданных")]
static FRONTMATTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?mR)\A(?:\u{FEFF})?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|\z)")
        .expect("выражение границ YAML")
});

#[expect(clippy::expect_used, reason = "литерал соответствует схеме YAML Core")]
static NUMBER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"\A(?:0o[0-7]+|0x[0-9a-fA-F]+|[-+]?(?:[0-9]+|\.[0-9]+|[0-9]+\.[0-9]*)(?:[eE][-+]?[0-9]+)?",
        r"|[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)\z"
    ))
    .expect("выражение чисел YAML Core")
});

#[derive(Clone, PartialEq, Eq, Hash)]
enum Scalar {
    Text(String),
    Null,
    Bool(bool),
    Number(u64),
}

#[derive(Default)]
enum Node {
    Scalar(Scalar),
    Alias(usize),
    Sequence(Vec<Node>),
    #[default]
    Mapping,
}

enum Frame {
    Sequence {
        keep: bool,
        entries: Vec<Node>,
    },
    Mapping {
        keys: HashSet<Scalar>,
        key: Option<Node>,
    },
}

pub(crate) fn metadata(source: &str) -> (Vec<String>, Vec<String>) {
    let Some(raw) = FRONTMATTER
        .captures(source)
        .and_then(|capture| capture.get(1))
    else {
        return (vec![], vec![]);
    };
    parse(raw.as_str()).unwrap_or_default()
}

fn parse(raw: &str) -> Option<(Vec<String>, Vec<String>)> {
    let mut parser = Parser::new_from_str(raw);
    let mut frames = Vec::new();
    let mut anchors = HashMap::new();
    let mut aliases = Vec::new();
    let mut tags = Vec::new();
    let mut complete = false;
    loop {
        let (event, _) = parser.next_token().ok()?;
        let node = match event {
            Event::MappingStart(..) => {
                frames.push(Frame::Mapping {
                    keys: HashSet::new(),
                    key: None,
                });
                continue;
            }
            Event::SequenceStart(..) => {
                // Нужно хранить только элементы прямых последовательностей в корневой карте.
                let keep = matches!(frames.as_slice(), [Frame::Mapping { key: Some(Node::Scalar(Scalar::Text(key))), .. }] if matches!(key.as_str(), "tags" | "aliases"));
                frames.push(Frame::Sequence {
                    keep,
                    entries: vec![],
                });
                continue;
            }
            Event::MappingEnd => {
                frames.pop()?;
                Node::Mapping
            }
            Event::SequenceEnd => {
                let Frame::Sequence { entries, .. } = frames.pop()? else {
                    return None;
                };
                Node::Sequence(entries)
            }
            Event::Scalar(value, style, id, tag) => {
                let value = scalar(value, style, tag.as_ref());
                if id != 0 {
                    anchors.insert(id, value.clone());
                }
                Node::Scalar(value)
            }
            Event::Alias(id) => Node::Alias(id),
            Event::DocumentStart if complete => return None,
            Event::DocumentEnd => {
                complete = true;
                continue;
            }
            Event::StreamEnd => return Some((aliases, tags)),
            Event::StreamStart | Event::DocumentStart | Event::Nothing => continue,
        };
        let root = frames.len() == 1;
        match frames.last_mut() {
            Some(Frame::Mapping { keys, key }) => {
                if let Some(old_key) = key.take() {
                    if let Node::Scalar(value) = old_key {
                        if root
                            && let Scalar::Text(name) = &value
                            && let Node::Sequence(entries) = node
                        {
                            let target = match name.as_str() {
                                "aliases" => Some(&mut aliases),
                                "tags" => Some(&mut tags),
                                _ => None,
                            };
                            if let Some(target) = target {
                                target.extend(entries.into_iter().filter_map(
                                    |entry| match entry {
                                        Node::Scalar(Scalar::Text(text)) => Some(text),
                                        Node::Alias(id) => match anchors.get(&id) {
                                            Some(Scalar::Text(text)) => Some(text.clone()),
                                            _ => None,
                                        },
                                        Node::Scalar(_) | Node::Sequence(_) | Node::Mapping => None,
                                    },
                                ));
                            }
                        }
                        if !keys.insert(value) {
                            return None;
                        }
                    }
                } else {
                    *key = Some(node);
                }
            }
            Some(Frame::Sequence { keep, entries }) if *keep => entries.push(node),
            Some(Frame::Sequence { .. }) | None => (),
        }
    }
}

fn scalar(text: String, style: TScalarStyle, tag: Option<&Tag>) -> Scalar {
    let explicit = tag.map(|tag| (tag.handle.as_str(), tag.suffix.as_str()));
    let implicit = explicit.is_none() && style == TScalarStyle::Plain;
    let permits = |kind| implicit || explicit == Some(("tag:yaml.org,2002:", kind));
    if permits("null") && matches!(text.as_str(), "" | "~" | "null" | "Null" | "NULL") {
        return Scalar::Null;
    }
    if permits("bool") {
        match text.as_str() {
            "true" | "True" | "TRUE" => return Scalar::Bool(true),
            "false" | "False" | "FALSE" => return Scalar::Bool(false),
            _ => (),
        }
    }
    if (permits("int") || permits("float")) && NUMBER.is_match(&text) {
        let number = if let Some((digits, radix)) = text
            .strip_prefix("0o")
            .map(|s| (s, 8))
            .or_else(|| text.strip_prefix("0x").map(|s| (s, 16)))
        {
            digits
                .bytes()
                .filter_map(|byte| char::from(byte).to_digit(radix))
                .fold(0.0, |value, digit| {
                    value * f64::from(radix) + f64::from(digit)
                })
        } else {
            match text.to_ascii_lowercase().as_str() {
                ".inf" | "+.inf" => f64::INFINITY,
                "-.inf" => f64::NEG_INFINITY,
                ".nan" => f64::NAN,
                _ => text.parse().unwrap_or(f64::NAN),
            }
        };
        return Scalar::Number((number + 0.0).to_bits());
    }
    Scalar::Text(text)
}
