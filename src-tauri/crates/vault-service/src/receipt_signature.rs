use serde::{Serialize, Serializer, ser::SerializeMap};
use serde_json::{Value, json};
use vault_read::sha256;

use crate::ApiError;

// Порядок полей сохраняет подпись существующих квитанций TypeScript.
struct Fields<'a>(&'a [(&'a str, Option<Value>)]);

impl Serialize for Fields<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        for (key, value) in self.0 {
            if let Some(value) = value {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

fn digest(fields: &[(&str, Option<Value>)]) -> Result<String, ApiError> {
    Ok(sha256(&serde_json::to_vec(&Fields(fields))?))
}

const ASSET: &[(&str, &str)] = &[
    ("path", "path"),
    ("source", "source"),
    ("expectedVersion", "expected_version"),
    ("layout", "layout"),
];

fn array(args: &Value, field: &str, keys: &[(&str, &str)]) -> Option<serde_json::Result<String>> {
    let entries = args.get(field)?.as_array()?;
    let nested = entries
        .iter()
        .map(|entry| {
            keys.iter()
                .map(|&(camel, snake)| {
                    (
                        camel,
                        entry.get(camel).or_else(|| entry.get(snake)).cloned(),
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let fields = nested.iter().map(|entry| Fields(entry)).collect::<Vec<_>>();
    Some(serde_json::to_string(&fields))
}

pub fn legacy(key: &str, operation: &str, args: &Value) -> Result<Option<String>, ApiError> {
    let get = |name: &str| args.get(name).cloned();
    match operation {
        "add_page" => digest(&[
            ("operation", Some(json!("add_page"))),
            ("title", get("title")),
            ("path", get("path")),
            ("source", get("source")),
            ("format", get("format")),
            ("requestId", Some(json!(key))),
            ("aliases", get("aliases")),
            ("tags", get("tags")),
        ])
        .map(Some),
        "write_document" => {
            let assets = array(args, "assets", ASSET).transpose()?;
            let references = array(
                args,
                "references",
                &[("path", "path"), ("expectedVersion", "expected_version")],
            )
            .transpose()?;
            let base = serde_json::to_string(&Fields(&[
                ("operation", Some(json!("write_document"))),
                ("pageId", get("path")),
                (
                    "expectedRevision",
                    get("expected_revision").or_else(|| get("expectedRevision")),
                ),
                (
                    "expectedVersion",
                    get("expected_version").or_else(|| get("expectedVersion")),
                ),
                ("source", get("source")),
            ]))?;
            let mut bytes = base.trim_end_matches('}').as_bytes().to_vec();
            // Последняя строка может содержать '}', но сериализованный объект всегда
            // заканчивается одним структурным закрывающим символом после значения.
            if let Some(assets) = assets {
                bytes.extend_from_slice(b",\"assets\":");
                bytes.extend_from_slice(assets.as_bytes());
            }
            if let Some(references) = references {
                bytes.extend_from_slice(b",\"references\":");
                bytes.extend_from_slice(references.as_bytes());
            }
            bytes.push(b'}');
            Ok(Some(sha256(&bytes)))
        }
        "write_markdown" | "write_diagram" => {
            let kind = if operation == "write_markdown" {
                json!("markdown")
            } else {
                get("format").unwrap_or_else(|| json!("mermaid"))
            };
            let title = get("title").map(|title| {
                title
                    .as_str()
                    .filter(|title| !title.trim().is_empty())
                    .map_or(Value::Null, |title| {
                        json!(title.trim().chars().take(200).collect::<String>())
                    })
            });
            let layout = (kind.as_str() == Some("bpmn"))
                .then(|| get("layout"))
                .flatten();
            let at = ("at", get("at"));
            let version = ("expectedVersion", get("expected_version"));
            let title = ("title", title);
            let options = if operation == "write_markdown" {
                [("layout", None), at, version, title]
            } else {
                [("layout", layout), title, at, version]
            };
            let options = serde_json::to_string(&Fields(&options))?;
            let base = serde_json::to_string(&Fields(&[
                ("operation", Some(json!("write_block"))),
                ("pageId", get("page_id")),
                ("blockId", get("block_id")),
                ("type", Some(kind)),
                ("source", get("source")),
                ("expectedRevision", get("expected_revision")),
            ]))?;
            let signature = format!("{},\"options\":{options}}}", base.trim_end_matches('}'));
            Ok(Some(sha256(signature.as_bytes())))
        }
        _ => Ok(None),
    }
}
