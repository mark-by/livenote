use std::collections::BTreeMap;

use serde_json::{Map, Value, json};
use unicode_normalization::UnicodeNormalization;
use vault_files::PathRename;
use vault_read::{VaultDocument, diagram_format, parse_document};

use crate::{
    ApiError,
    args::Expected,
    events::{event, publish},
    links::rewrite,
    source::Source,
    state::{State, note_path, user_path},
    transaction::{Change, Plan},
};

fn fold(path: &str) -> String {
    path.nfc()
        .flat_map(char::to_lowercase)
        .map(|ch| if ch == 'ς' { 'σ' } else { ch })
        .collect()
}

pub fn child(path: &str, parent: &str) -> bool {
    path.strip_prefix(parent)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

#[derive(Clone, Copy)]
pub enum Move<'a> {
    Folder {
        expected: &'a str,
    },
    Document {
        expected: &'a Expected,
        source: Option<&'a str>,
    },
}

impl State {
    pub(crate) fn destination(&self, path: &str, except: Option<&str>) -> Result<(), ApiError> {
        user_path(path)?;
        let folded = fold(path);
        if self
            .listing
            .files
            .iter()
            .chain(&self.listing.folders)
            .chain(&self.listing.hidden_entries)
            .any(|entry| {
                Some(entry.as_str()) != except
                    && (fold(entry) == folded
                        || (child(&folded, &fold(entry)) && !child(path, entry)))
            })
        {
            return Err(ApiError::destination(path, "Назначение уже существует"));
        }
        Ok(())
    }

    pub(crate) fn unique(&self, base: &str, ext: &str) -> Result<String, ApiError> {
        for index in 1..=u32::MAX {
            let path = if index == 1 {
                format!("{base}.{ext}")
            } else {
                format!("{base} {index}.{ext}")
            };
            match self.destination(&path, None) {
                Ok(()) if self.files.read_optional(&path)?.is_none() => return Ok(path),
                Ok(()) => (),
                Err(error)
                    if error.code == "conflict"
                        && self
                            .listing
                            .files
                            .iter()
                            .chain(&self.listing.folders)
                            .chain(&self.listing.hidden_entries)
                            .any(|entry| fold(entry) == fold(&path)) => {}
                Err(error) => return Err(error),
            }
        }
        Err(ApiError::invalid("Не удалось выбрать имя файла"))
    }

    pub(crate) fn move_path(
        &mut self,
        from: &str,
        to: &str,
        kind: Move<'_>,
    ) -> Result<Value, ApiError> {
        let path_from = user_path(from)?;
        let path_to = user_path(to)?;
        let (folder, replacement) = match kind {
            Move::Folder { expected } => {
                self.check_tree(expected)?;
                self.folder_safe(from)?;
                if child(to, from) {
                    return Err(ApiError::invalid("Нельзя переместить папку внутрь себя"));
                }
                (true, None)
            }
            Move::Document { expected, source } => {
                self.check(from, expected)?;
                note_path(to)?;
                if diagram_format(from) != diagram_format(to) {
                    return Err(ApiError::invalid("Расширение должно сохранять формат"));
                }
                (false, source)
            }
        };
        if from == to {
            let mut result = move_fields(&[], &[], self.projection.tree_version());
            if !folder {
                result.insert(
                    "document".into(),
                    json!(self.render_fields(self.require(from)?.document())),
                );
            }
            return Ok(Value::Object(result));
        }
        self.destination(to, Some(from))?;
        let mapping = self
            .listing
            .files
            .iter()
            .chain(&self.listing.folders)
            .filter(|path| *path == from || (folder && child(path, from)))
            .filter_map(|path| {
                path.strip_prefix(from)
                    .map(|suffix| (path.clone(), format!("{to}{suffix}")))
            })
            .collect::<BTreeMap<_, _>>();
        let mut plan = Plan {
            rename: Some(PathRename {
                from: path_from,
                to: path_to,
            }),
            ..Plan::default()
        };
        let mut updated = Vec::new();
        let pages = self
            .projection
            .documents()
            .map(vault_read::ParsedDocument::document)
            .collect::<Vec<_>>();
        for file in &self.listing.files {
            let mapped = mapping.get(file);
            let target = mapped.map_or(file, |path| path);
            let old = self.projection.document(file);
            let candidate = if file == from {
                replacement
                    .map(|source| {
                        parse_document(file, source, |asset| Source(&self.files).asset(asset))
                    })
                    .transpose()?
            } else {
                None
            };
            let next = candidate
                .as_ref()
                .or(old)
                .filter(|_| diagram_format(file).is_none())
                .map(|doc| rewrite(doc, (&pages, &self.listing.files), &mapping))
                .transpose()?;
            if let Some(next) = next.filter(|next| old.is_some_and(|old| old.source() != next)) {
                let old = old.ok_or_else(|| ApiError::not_found("Документ не найден"))?;
                plan.writes.push(Change::new(
                    target,
                    Some(old.source().as_bytes().to_vec()),
                    Some(next.into_bytes()),
                )?);
                if let Some(candidate) = &candidate {
                    self.collect_unused(&mut plan, old.document(), Some(candidate.document()))?;
                }
            } else if mapped.is_none() {
                continue;
            } else if let Some(doc) = old {
                let bytes = doc.source().as_bytes().to_vec();
                plan.writes
                    .push(Change::new(target, Some(bytes.clone()), Some(bytes))?);
            }
            updated.push(target.clone());
        }
        self.finish_move(&plan, (&mapping, &updated), (from, to, folder))
    }
    fn finish_move(
        &mut self,
        plan: &Plan,
        changes: (&BTreeMap<String, String>, &[String]),
        paths: (&str, &str, bool),
    ) -> Result<Value, ApiError> {
        let (from, to, folder) = paths;
        let (mapping, updated) = changes;
        let before = self.revisions();
        self.commit(plan, from)?;
        let moved = mapping
            .iter()
            .map(|(from, to)| json!({"from": from, "to": to}))
            .collect::<Vec<Value>>();
        let mut result = move_fields(&moved, updated, self.projection.tree_version());
        if folder {
            self.emit("vault.updated", "", 0);
            self.related(&before, "");
        } else {
            let doc: &VaultDocument = self.require(to)?.document();
            result.insert("document".into(), json!(self.render_fields(doc)));
            let mut payload = event("page.moved", to, doc.page.revision);
            payload.insert("previousPath".into(), json!(from));
            payload.insert("origin".into(), json!("api"));
            publish(&self.events, payload);
            self.emit("vault.updated", "", 0);
            self.related(&before, to);
        }
        Ok(Value::Object(result))
    }
}

fn move_fields(moved: &[Value], updated: &[String], version: &str) -> Map<String, Value> {
    Map::from_iter([
        ("moved".into(), json!(moved)),
        ("updatedPaths".into(), json!(updated)),
        ("treeVersion".into(), json!(version)),
    ])
}
