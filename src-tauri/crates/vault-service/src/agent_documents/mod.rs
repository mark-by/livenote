//! Работа агента в одном явно выбранном хранилище.

mod diagrams;
mod publication;
mod snapshot;
mod stage_diagram;
mod text;
mod topic;
mod types;

use std::{
    collections::{BTreeMap, HashMap},
    num::NonZeroUsize,
    sync::Arc,
};

use vault_read::file_version;

use crate::{ApiError, diagram::Validator, registry::Entry, service::access, state::State};

use snapshot::Snapshot;
use text::Reading;
pub use types::*;

const BINDINGS: &str = "livenote.bindings.json";

/// Удерживает открытое хранилище на время работы вызывающей стороны.
#[derive(Clone)]
pub struct VaultRef {
    entry: Arc<Entry>,
    validator: Arc<Validator>,
}

/// Хранит снимки чтения и подготовленные правки одного сообщения.
pub struct DocTurn {
    vault: VaultRef,
    snapshot: Snapshot,
    diagram_failures: BTreeMap<String, DiagramValidation>,
    reads: HashMap<ReadId, Reading>,
    folder: String,
    focused: Option<String>,
}

impl VaultRef {
    pub(crate) const fn new(entry: Arc<Entry>, validator: Arc<Validator>) -> Self {
        Self { entry, validator }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.entry.id
    }

    pub async fn folder_exists(&self, folder: &str) -> Result<bool, ApiError> {
        if folder.is_empty() {
            return Ok(true);
        }
        crate::state::user_path(folder)?;
        let folder = folder.to_owned();
        access(Arc::clone(&self.entry), move |state| {
            Ok(state.listing.folders.contains(&folder))
        })
        .await
    }

    pub async fn turn(&self, focus: CapturedFocus) -> Result<DocTurn, ApiError> {
        let (folder, focused) = match &focus {
            CapturedFocus::Folder { folder } => (folder.clone(), None),
            CapturedFocus::Document { path, .. } | CapturedFocus::Diagram { path, .. } => (
                path.rsplit_once('/')
                    .map_or("", |(parent, _)| parent)
                    .to_owned(),
                Some(path.clone()),
            ),
        };
        let snapshot = access(Arc::clone(&self.entry), move |state| {
            Snapshot::capture(state, focus)
        })
        .await?;
        Ok(DocTurn {
            vault: self.clone(),
            snapshot,
            diagram_failures: BTreeMap::new(),
            reads: HashMap::new(),
            folder,
            focused,
        })
    }

    /// Читает текст правил отдельно от документов и с отдельным лимитом.
    pub async fn instructions(&self) -> Result<Option<String>, ApiError> {
        access(Arc::clone(&self.entry), |state| {
            let path = "AGENTS.md";
            if !state.listing.files.iter().any(|file| file == path) {
                return Ok(None);
            }
            state
                .files
                .read_optional(path)?
                .map(|file| {
                    if file.bytes.len() > 32 * 1024 {
                        return Err(ApiError::invalid("Файл AGENTS.md превышает лимит"));
                    }
                    String::from_utf8(file.bytes)
                        .map_err(|_| ApiError::invalid("Файл AGENTS.md должен быть в UTF-8"))
                })
                .transpose()
        })
        .await
    }

    pub async fn read_bindings(&self) -> Result<Option<VersionedBytes>, ApiError> {
        let vault = self.clone();
        crate::registry::blocking(move || vault.read_bindings_blocking()).await
    }

    pub async fn write_bindings(&self, input: CasBytes) -> Result<String, ApiError> {
        let vault = self.clone();
        crate::registry::blocking(move || vault.write_bindings_blocking(input)).await
    }

    /// Читает файл привязок в блокирующей задаче вызывающей стороны.
    pub fn read_bindings_blocking(&self) -> Result<Option<VersionedBytes>, ApiError> {
        self.entry.access(|state| {
            state
                .files
                .read_optional(BINDINGS)?
                .map(|file| {
                    text::check_size(file.bytes.len())?;
                    Ok(VersionedBytes {
                        version: file_version(&file.bytes),
                        bytes: file.bytes,
                    })
                })
                .transpose()
        })
    }

    /// Сверяет версию и записывает файл привязок в блокирующей задаче вызывающей стороны.
    pub fn write_bindings_blocking(&self, input: CasBytes) -> Result<String, ApiError> {
        text::check_size(input.bytes.len())?;
        self.entry.access(move |state| {
            state.refresh(true)?;
            let before = state.files.read_optional(BINDINGS)?.map(|file| file.bytes);
            if before.as_deref().map(file_version) != input.expected_version {
                return Err(state.stale(&[BINDINGS], None));
            }
            if before.is_none() {
                state.destination(BINDINGS, None)?;
            }
            let version = file_version(&input.bytes);
            let mut plan = crate::transaction::Plan::default();
            plan.writes.push(crate::transaction::Change::new(
                BINDINGS,
                before,
                Some(input.bytes),
            )?);
            state.commit(&plan, BINDINGS)?;
            Ok(version)
        })
    }
}

impl DocTurn {
    pub async fn discover(&self) -> Result<Vec<Hit>, ApiError> {
        let visible = self.snapshot.visible_sources();
        let folder = self.folder.clone();
        let focused = self.focused.clone();
        access(Arc::clone(&self.vault.entry), move |state| {
            Ok(text::discover(state, &visible, &folder, focused.as_deref()))
        })
        .await
    }

    pub async fn search(&self, query: Query) -> Result<Vec<Hit>, ApiError> {
        self.search_in(query, None).await
    }

    pub async fn search_project(&self, query: Query) -> Result<Vec<Hit>, ApiError> {
        self.search_in(query, Some(self.folder.clone())).await
    }

    async fn search_in(&self, query: Query, folder: Option<String>) -> Result<Vec<Hit>, ApiError> {
        let staged = self.snapshot.visible_sources();
        access(Arc::clone(&self.vault.entry), move |state| {
            let files = text::documents(state, &staged).filter(|doc| {
                folder
                    .as_ref()
                    .is_none_or(|folder| text::relative_to(doc.path, folder).is_some())
            });
            text::search(files, &query)
        })
        .await
    }

    pub async fn read(&mut self, path: &str, lines: Lines) -> Result<Read, ApiError> {
        if self.reads.len() >= 128 {
            return Err(ApiError::invalid("Превышен лимит чтений"));
        }
        let path = path.to_owned();
        let mut snapshot = self.snapshot.clone();
        let (next, result) = access(Arc::clone(&self.vault.entry), move |state| {
            let result = snapshot.load(state, &path).and_then(|()| {
                let source = snapshot.editable_source(&path)?;
                let line = NonZeroUsize::new(lines.first);
                let target = snapshot.source_target(&path, line);
                text::read(&path, &source, lines, target)
            });
            Ok((snapshot, result))
        })
        .await?;
        let (read, reading) = result?;
        self.snapshot = next;
        self.reads.insert(read.read_id, reading);
        Ok(read)
    }

    pub async fn check(&self, input: DiagramInput) -> Result<DiagramValidation, ApiError> {
        text::check_size(input.source.len())?;
        Ok(self
            .vault
            .validator
            .engine
            .validate(input.format, &input.source, self.vault.validator.theme)
            .await)
    }

    pub async fn stage(&mut self, edit: Edit) -> Result<NavigationTarget, ApiError> {
        match edit {
            Edit::Create { path, source } => {
                crate::state::note_path(&path)?;
                text::check_size(source.len())?;
                let candidate = path.clone();
                access(Arc::clone(&self.vault.entry), move |state| {
                    new_destination(state, &candidate)
                })
                .await?;
                self.snapshot.create(path.clone(), source)?;
                Ok(NavigationTarget::new(path, None, true))
            }
            Edit::Patch {
                read_id,
                edits,
                layout,
            } => {
                let reading = self
                    .reads
                    .get(&read_id)
                    .ok_or_else(|| ApiError::invalid("Снимок чтения не найден в этом сообщении"))?;
                self.snapshot.patch(reading, &edits, layout)
            }
        }
    }

    pub fn has_staged_changes(&self) -> bool {
        self.snapshot.files.values().any(snapshot::File::edited)
    }

    /// Проверяет общий план и публикует его одной транзакцией.
    pub async fn commit(self) -> Result<Vec<String>, ApiError> {
        let Self {
            vault,
            snapshot,
            diagram_failures,
            ..
        } = self;
        if let Some((path, validation)) = diagram_failures.first_key_value() {
            return Err(crate::diagram::invalid(path, Some(validation)));
        }
        let prepared = access(Arc::clone(&vault.entry), move |state| {
            publication::prepare(state, snapshot)
        })
        .await?;
        let ready = prepared.validate(&vault.validator).await?;
        access(vault.entry, move |state| ready.commit(state)).await
    }
}

fn new_destination(state: &State, path: &str) -> Result<(), ApiError> {
    let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
    if !parent.is_empty() && !state.listing.folders.iter().any(|folder| folder == parent) {
        return Err(state.stale(&[parent], None));
    }
    empty_destination(state, path)
}

fn empty_destination(state: &State, path: &str) -> Result<(), ApiError> {
    state.destination(path, None)?;
    if state.files.read_optional(path)?.is_some() {
        return Err(state.stale(&[path], None));
    }
    Ok(())
}
