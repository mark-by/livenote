use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
};

use serde_json::{Value, json};
use tokio::sync::broadcast;
use vault_files::{RelativePath, VaultFiles, VaultListing};
use vault_read::{
    ParsedDocument, VaultDocument, VaultIndex, VaultProjection, VaultSnapshot, openable,
};

use crate::{
    ApiError,
    args::{Expected, Rendered},
    events::{event, publish},
    source::{Source, problem, scan},
};

pub struct State {
    pub(crate) files: VaultFiles,
    pub(crate) listing: VaultListing,
    pub(crate) projection: VaultProjection,
    pub(crate) name: String,
    pub(crate) events: broadcast::Sender<Value>,
    pub(crate) renders: HashMap<String, BTreeMap<String, Rendered>>,
}

impl State {
    pub(crate) fn open(
        root: &Path,
        name: &str,
        events: broadcast::Sender<Value>,
    ) -> Result<Self, ApiError> {
        let files = VaultFiles::open(root)?;
        let canonical = root
            .to_str()
            .ok_or_else(|| ApiError::invalid("Путь хранилища должен быть в UTF-8"))?;
        let projection = std::env::var_os("HOME").map_or_else(VaultProjection::new, |home| {
            VaultProjection::with_index(VaultIndex::new(
                &PathBuf::from(home).join(".livenote"),
                canonical,
            ))
        });
        let mut state = Self {
            files,
            listing: VaultListing::default(),
            projection,
            name: name.to_owned(),
            events,
            renders: HashMap::new(),
        };
        state.refresh(false)?;
        Ok(state)
    }

    pub(crate) fn refresh(&mut self, external: bool) -> Result<(), ApiError> {
        let before = external.then(|| self.revisions());
        let listing = self.files.list()?;
        let problems = listing.problems.iter().map(problem).collect::<Vec<_>>();
        let recovery = self
            .files
            .recovery_problems()
            .iter()
            .map(problem)
            .collect::<Vec<_>>();
        let tree_before = self.projection.tree_version().to_owned();
        let scan = scan(&listing, (&problems, &recovery));
        self.projection.reconcile(scan, &Source(&self.files));
        self.listing = listing;
        if let Some(before) = before {
            let after = self.revisions();
            for (path, revision) in &after {
                let name = match before.get(path) {
                    Some(old) if old == revision => continue,
                    Some(_) => "page.updated",
                    None => "page.created",
                };
                self.emit_external(name, path, *revision);
            }
            for (path, revision) in before {
                if !after.contains_key(&path) {
                    self.emit_external("page.deleted", &path, revision);
                }
            }
            if self.projection.tree_version() != tree_before {
                self.emit_external("vault.updated", "", 0);
            }
        }
        Ok(())
    }

    pub(crate) fn revisions(&self) -> BTreeMap<String, u64> {
        self.projection
            .documents()
            .map(|item| (item.document().path.clone(), item.document().page.revision))
            .collect()
    }

    pub(crate) fn related(&self, before: &BTreeMap<String, u64>, primary: &str) {
        for document in self.projection.documents().map(ParsedDocument::document) {
            if document.path != primary
                && before.get(&document.path) != Some(&document.page.revision)
            {
                self.emit("page.updated", &document.path, document.page.revision);
            }
        }
    }

    pub(crate) fn emit(&self, name: &str, path: &str, revision: u64) {
        let mut payload = event(name, path, revision);
        payload.insert("origin".into(), json!("api"));
        publish(&self.events, payload);
    }

    fn emit_external(&self, name: &str, path: &str, revision: u64) {
        let mut payload = event(name, path, revision);
        payload.insert("origin".into(), json!("external"));
        publish(&self.events, payload);
    }

    pub(crate) fn snapshot(&self) -> VaultSnapshot {
        self.projection.snapshot(Some(&self.name))
    }

    pub(crate) fn require(&self, path: &str) -> Result<&ParsedDocument, ApiError> {
        note_path(path)?;
        if let Some(doc) = self.projection.document(path) {
            return Ok(doc);
        }
        let problems = self
            .projection
            .problems()
            .iter()
            .filter(|item| item.path == path)
            .collect::<Vec<_>>();
        if problems.is_empty() {
            Err(ApiError::not_found("Документ не найден").details(json!({"pageId": path})))
        } else {
            Err(ApiError::new(409, "conflict", "Документ требует исправления").details(json!({
                "currentRevision": 0, "reason": "document_problem","paths": [path], "problems": problems,
            })))
        }
    }

    pub(crate) fn check(
        &self,
        path: &str,
        expected: &Expected,
    ) -> Result<&ParsedDocument, ApiError> {
        let parsed = self.require(path).map_err(|error| {
            if error.status == 404 {
                ApiError::missing(path)
            } else {
                error
            }
        })?;
        let doc = parsed.document();
        if doc.page.revision != expected.expected_revision
            || expected
                .expected_version
                .as_ref()
                .is_some_and(|v| v != &doc.version)
        {
            return Err(self.stale(&[path], Some(doc)));
        }
        Ok(parsed)
    }

    pub(crate) fn stale(&self, paths: &[&str], doc: Option<&VaultDocument>) -> ApiError {
        ApiError::stale(paths, doc, self.projection.tree_version())
    }

    pub(crate) fn check_tree(&self, version: &str) -> Result<(), ApiError> {
        if self.projection.tree_version() != version {
            return Err(self.stale(&[], None));
        }
        Ok(())
    }

    pub(crate) fn render_fields(&self, doc: &VaultDocument) -> VaultDocument {
        let mut doc = doc.clone();
        if let Some(confirmations) = self.renders.get(&doc.path) {
            for block in &mut doc.page.blocks {
                if let Some(confirmation) = confirmations
                    .get(&block.id)
                    .filter(|item| item.revision == doc.page.revision)
                {
                    block.rendered_revision = Some(confirmation.revision);
                    block.render_ok = Some(confirmation.ok);
                    block.render_error = confirmation.error.clone();
                }
            }
        }
        doc
    }
}
pub fn note_path(path: &str) -> Result<RelativePath, ApiError> {
    let relative = user_path(path)?;
    if !openable(path) {
        return Err(ApiError::invalid("Расширение документа не поддерживается"));
    }
    Ok(relative)
}

pub fn user_path(path: &str) -> Result<RelativePath, ApiError> {
    let relative = RelativePath::new(path)?;
    if path
        .split('/')
        .any(|part| part.eq_ignore_ascii_case(".git") || part.eq_ignore_ascii_case(".livenote"))
        || path
            .split('/')
            .next()
            .is_some_and(|part| part.eq_ignore_ascii_case(".livenoteignore"))
    {
        return Err(ApiError::invalid("Путь зарезервирован"));
    }
    Ok(relative)
}
