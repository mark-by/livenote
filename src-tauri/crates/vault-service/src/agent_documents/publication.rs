use std::collections::{BTreeMap, BTreeSet};

use vault_files::DirectoryChange;
use vault_read::{ParsedDocument, file_version};

use crate::{
    ApiError,
    diagram::{self, Validator},
    state::{State, user_path},
    transaction::{Change, Plan},
};

use super::{
    DiagramFormat, Layout,
    diagrams::Check,
    snapshot::{self, File, Snapshot},
};

pub(super) struct Prepared {
    snapshot: Snapshot,
    plan: Plan,
    checks: Vec<Check>,
}

pub(super) struct Validated {
    snapshot: Snapshot,
    plan: Plan,
}

pub(super) fn prepare(state: &State, mut snapshot: Snapshot) -> Result<Prepared, ApiError> {
    let active = snapshot
        .overlay
        .as_ref()
        .filter(|draft| draft.active(&snapshot.files));
    let desired = snapshot
        .files
        .iter()
        .filter_map(|(path, file)| {
            let accept_draft = active
                .is_some_and(|draft| draft.owner == *path || draft.asset.as_ref() == Some(path));
            (file.edited() || accept_draft)
                .then(|| {
                    file.effective()
                        .map(|source| (path.clone(), source.to_owned()))
                })
                .flatten()
        })
        .collect::<BTreeMap<_, _>>();
    if desired.is_empty() {
        return Ok(Prepared {
            snapshot,
            plan: Plan::default(),
            checks: Vec::new(),
        });
    }
    snapshot.verify(state)?;
    let draft_sources = snapshot
        .files
        .iter()
        .filter_map(|(path, file)| {
            file.agent_base()
                .map(|source| (path.clone(), source.to_owned()))
        })
        .collect::<BTreeMap<_, _>>();
    let mut checks = Vec::new();
    let mut plan = Plan {
        directories: snapshot
            .new_directories
            .iter()
            .map(|path| DirectoryChange {
                path: path.clone(),
                old: false,
                next: true,
            })
            .collect(),
        ..Plan::default()
    };
    let mut destinations = BTreeSet::new();
    for (path, source) in &desired {
        let file = snapshot
            .files
            .get(path)
            .ok_or_else(|| ApiError::missing(path))?;
        if file.disk.is_none() && !destinations.insert(crate::tree::fold(path)) {
            return Err(ApiError::destination(
                path,
                "Назначение совпадает с другой подготовленной записью",
            ));
        }
        if file.disk.as_ref() != Some(source) || file.edited() {
            plan.writes.push(Change::new(
                path,
                file.disk.as_ref().map(|source| source.as_bytes().to_vec()),
                Some(source.as_bytes().to_vec()),
            )?);
        }
        if file.disk.is_none()
            && let Some((parent, _)) = path.rsplit_once('/')
            && !plan
                .directories
                .iter()
                .any(|item| item.path.as_str() == parent)
        {
            plan.directories.push(DirectoryChange {
                path: user_path(parent)?,
                old: true,
                next: true,
            });
        }
        let parsed = snapshot::parse(state, path, source, |path| {
            desired.get(path).map(String::as_str)
        })?;
        if let Some(format) = snapshot::diagram_format(path) {
            if let Some(owner) = snapshot.managed_assets.get(path)
                && !desired.contains_key(owner)
            {
                return Err(diagram::invalid(path, None));
            }
            if file.disk.as_ref() != Some(source) || file.edited() {
                checks.push(Check {
                    path: path.clone(),
                    format,
                    next: source.clone(),
                    previous: file.agent_base().map(str::to_owned),
                    drawio_page: file.editable_page.clone(),
                    layout: file.layout,
                });
            }
            continue;
        }
        for (asset, owner) in &snapshot.managed_assets {
            if owner == path
                && !parsed
                    .spans()
                    .iter()
                    .any(|span| span.asset_path.as_ref() == Some(asset))
            {
                return Err(diagram::invalid(asset, None));
            }
        }
        note_checks(state, path, file, &parsed, &draft_sources, &mut checks)?;
        for asset in &parsed.document().assets {
            snapshot.pin_dependency(state, &asset.path)?;
            let captured = desired.get(&asset.path).map(String::as_str).or_else(|| {
                snapshot
                    .files
                    .get(&asset.path)
                    .and_then(|file| file.disk.as_deref())
            });
            if captured.map(|source| file_version(source.as_bytes())) != asset.version {
                return Err(state.stale(&[&asset.path], None));
            }
            if asset.source.is_none()
                && !state.projection.document(path).is_some_and(|old| {
                    old.document()
                        .assets
                        .iter()
                        .any(|prior| prior.path == asset.path && prior.source.is_none())
                })
            {
                return Err(diagram::invalid(path, None));
            }
        }
    }
    for (path, file) in &snapshot.files {
        if plan.writes.iter().any(|entry| entry.path.as_str() == path) {
            continue;
        }
        let before = file.disk.as_ref().map(|source| source.as_bytes().to_vec());
        let guard = Change::new(path, before.clone(), before)?;
        if state.listing.files.contains(path) {
            plan.writes.push(guard);
        } else {
            plan.hidden_guards.push(guard);
        }
    }
    Ok(Prepared {
        snapshot,
        plan,
        checks,
    })
}

fn note_checks(
    state: &State,
    path: &str,
    file: &File,
    next: &ParsedDocument,
    drafts: &BTreeMap<String, String>,
    checks: &mut Vec<Check>,
) -> Result<(), ApiError> {
    let base = file
        .agent_base()
        .map(|source| {
            snapshot::parse(state, path, source, |path| {
                drafts.get(path).map(String::as_str)
            })
        })
        .transpose()?;
    let disk = state.projection.document(path);
    for format in [
        DiagramFormat::Mermaid,
        DiagramFormat::Bpmn,
        DiagramFormat::Drawio,
    ] {
        let mut old = base
            .as_ref()
            .map_or_else(Vec::new, |doc| inline(doc, format));
        let mut edited = Vec::new();
        let disk_blocks = disk.map_or_else(Vec::new, |doc| inline(doc, format));
        for source in inline(next, format) {
            if let Some(index) = old.iter().position(|previous| *previous == source) {
                old.remove(index);
                if disk_blocks.contains(&source) {
                    continue;
                }
                checks.push(inline_check(path, format, source, None));
            } else {
                edited.push(source);
            }
        }
        if !old.is_empty() && (old.len() != 1 || edited.len() != 1) {
            return Err(diagram::invalid(path, None));
        }
        for source in edited {
            checks.push(inline_check(path, format, source, old.pop()));
        }
    }
    // Проверяем вновь добавленную ссылку и уже существующий файл схемы.
    for asset in &next.document().assets {
        if let Some(source) = &asset.source
            && let Some(format) = snapshot::diagram_format(&asset.path)
            && !disk.is_some_and(|doc| {
                doc.document()
                    .assets
                    .iter()
                    .any(|old| old.path == asset.path)
            })
            && !checks.iter().any(|check| check.path == asset.path)
        {
            checks.push(inline_check(&asset.path, format, source, None));
        }
    }
    Ok(())
}

fn inline(doc: &ParsedDocument, format: DiagramFormat) -> Vec<&str> {
    doc.document()
        .page
        .blocks
        .iter()
        .zip(doc.spans())
        .filter_map(|(block, span)| {
            (span.asset_path.is_none() && diagram::format(block.kind) == Some(format))
                .then_some(block.source.as_str())
        })
        .collect()
}

fn inline_check(path: &str, format: DiagramFormat, source: &str, previous: Option<&str>) -> Check {
    Check {
        path: path.to_owned(),
        format,
        next: source.to_owned(),
        previous: previous.map(str::to_owned),
        drawio_page: None,
        layout: Layout::Preserve,
    }
}

impl Prepared {
    pub async fn validate(mut self, validator: &Validator) -> Result<Validated, ApiError> {
        for check in self
            .checks
            .iter()
            .filter(|check| check.layout == Layout::Auto)
            .chain(
                self.checks
                    .iter()
                    .filter(|check| check.layout == Layout::Preserve),
            )
        {
            if check.layout == Layout::Preserve
                && self.checks.iter().any(|other| {
                    other.path == check.path
                        && other.next == check.next
                        && other.layout == Layout::Auto
                })
            {
                continue;
            }
            if let Some(source) = check.validate(validator).await? {
                let write = self
                    .plan
                    .writes
                    .iter_mut()
                    .find(|write| write.path.as_str() == check.path)
                    .ok_or_else(|| ApiError::invalid("Автораскладка требует записи файла"))?;
                write.after = Some(source.into_bytes());
            }
        }
        Ok(Validated {
            snapshot: self.snapshot,
            plan: self.plan,
        })
    }
}

impl Validated {
    pub(super) fn commit(self, state: &mut State) -> Result<Vec<String>, ApiError> {
        let paths = self
            .plan
            .writes
            .iter()
            .filter_map(|write| {
                let path = write.path.as_str();
                let file = self.snapshot.files.get(path)?;
                let after = write.after.as_ref()?;
                (file.edited() || Some(after) != write.before.as_ref()).then_some(path)
            })
            .collect::<Vec<_>>();
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        self.snapshot.verify(state)?;
        let before = state.revisions();
        state.commit(&self.plan, "")?;
        Ok(publish(state, &before, paths.into_iter()))
    }
}

fn publish<'a>(
    state: &State,
    before: &BTreeMap<String, u64>,
    paths: impl Iterator<Item = &'a str>,
) -> Vec<String> {
    let after = state.revisions();
    let mut paths = paths.map(str::to_owned).collect::<BTreeSet<_>>();
    for path in before.keys().chain(after.keys()) {
        if before.get(path) != after.get(path) {
            paths.insert(path.clone());
        }
    }
    for path in &paths {
        let (name, revision) = match (before.get(path), after.get(path)) {
            (Some(_), Some(next)) => ("page.updated", *next),
            (None, Some(next)) => ("page.created", *next),
            (Some(old), None) => ("page.deleted", *old),
            (None, None) => ("vault.updated", 0),
        };
        state.emit_with_origin(name, path, revision, "agent");
    }
    paths.into_iter().collect()
}
