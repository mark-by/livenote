use std::{
    collections::{BTreeMap, BTreeSet},
    num::NonZeroUsize,
};

use vault_files::RelativePath;
use vault_read::{ParsedDocument, Utf16Offset, file_version, parse_document};

use crate::{
    ApiError, args, diagram,
    edit::byte_range,
    source::Source,
    state::{State, note_path, user_path},
};

use super::{
    Base, CapturedFocus, DiagramFormat, Layout, NavigationTarget, Overlay, Patch, Target, diagrams,
    empty_destination, new_destination,
    text::{self, Reading},
};

#[derive(Clone, Default)]
pub(super) struct Snapshot {
    pub files: BTreeMap<String, File>,
    pub versions: BTreeMap<String, Base>,
    pub overlay: Option<Draft>,
    pub managed_assets: BTreeMap<String, String>,
    pub new_directories: BTreeSet<RelativePath>,
}

#[derive(Clone)]
pub(super) struct File {
    pub disk: Option<String>,
    pub draft: Option<String>,
    pub staged: Option<String>,
    pub layout: Layout,
    pub editable_page: Option<String>,
}

impl File {
    pub fn agent_base(&self) -> Option<&str> {
        self.draft.as_deref().or(self.disk.as_deref())
    }

    pub fn effective(&self) -> Option<&str> {
        self.staged.as_deref().or_else(|| self.agent_base())
    }

    pub fn edited(&self) -> bool {
        self.staged
            .as_deref()
            .is_some_and(|staged| Some(staged) != self.agent_base())
    }
}

#[derive(Clone)]
pub(super) struct Draft {
    pub owner: String,
    pub asset: Option<String>,
}

impl Draft {
    pub fn active(&self, files: &BTreeMap<String, File>) -> bool {
        files.get(&self.owner).is_some_and(File::edited)
            || self
                .asset
                .as_ref()
                .and_then(|asset| files.get(asset))
                .is_some_and(File::edited)
    }
}

impl Snapshot {
    pub fn capture(state: &State, focus: CapturedFocus) -> Result<Self, ApiError> {
        let mut snapshot = Self::default();
        match focus {
            CapturedFocus::Folder { folder } => {
                if !folder.is_empty() {
                    user_path(&folder)?;
                    if !state.listing.folders.contains(&folder) {
                        return Err(ApiError::not_found("Папка не найдена"));
                    }
                }
            }
            CapturedFocus::Document { path, base } => {
                require_base(state, &path, &base)?;
                snapshot.load(state, &path)?;
            }
            CapturedFocus::Diagram {
                path,
                base,
                format,
                target,
                selected,
                overlay,
            } => {
                require_base(state, &path, &base)?;
                snapshot.load(state, &path)?;
                snapshot.capture_diagram(state, &path, format, &target, overlay)?;
                if format == DiagramFormat::Drawio {
                    let pages = selected
                        .iter()
                        .filter_map(|item| item.page_id.as_deref())
                        .collect::<BTreeSet<_>>();
                    if pages.len() > 1 {
                        return Err(ApiError::invalid(
                            "Выберите элементы одной страницы draw.io",
                        ));
                    }
                    let diagram_path = match target {
                        Target::Asset { ref path } => path,
                        Target::File | Target::Inline { .. } => &path,
                    };
                    if let Some(file) = snapshot.files.get_mut(diagram_path) {
                        file.editable_page = pages.first().map(|id| (*id).to_owned());
                    }
                }
            }
        }
        Ok(snapshot)
    }

    fn capture_diagram(
        &mut self,
        state: &State,
        path: &str,
        format: DiagramFormat,
        target: &Target,
        overlay: Option<Overlay>,
    ) -> Result<(), ApiError> {
        let owner = state.require(path)?;
        let asset = match target {
            Target::Asset { path } => Some(path.clone()),
            Target::File | Target::Inline { .. } => None,
        };
        let next = if let Some(overlay) = overlay {
            require_base(
                state,
                path,
                &Base {
                    revision: overlay.expected_revision,
                    version: overlay.expected_version.clone(),
                },
            )?;
            text::check_size(overlay.source.len())?;
            let body = args::WriteDocument {
                path: path.to_owned(),
                expected: args::Expected {
                    expected_revision: overlay.expected_revision,
                    expected_version: Some(overlay.expected_version),
                },
                source: overlay.source,
                request_id: None,
                assets: overlay
                    .assets
                    .into_iter()
                    .map(|item| {
                        if asset.as_ref() != Some(&item.path) || item.layout == Layout::Auto {
                            return Err(ApiError::invalid(
                                "Черновик содержит запись вне целевой схемы",
                            ));
                        }
                        text::check_size(item.source.len())?;
                        Ok(args::Asset {
                            path: item.path,
                            source: item.source,
                            expected_version: item.expected_version,
                            layout: args::Layout::Preserve,
                        })
                    })
                    .collect::<Result<_, ApiError>>()?,
                references: overlay
                    .references
                    .into_iter()
                    .map(|item| args::Reference {
                        path: item.path,
                        expected_version: item.expected_version,
                    })
                    .collect(),
            };
            let candidate = state.write_document(&body, true)?;
            let next = state.preview(path, &candidate.plan)?;
            for change in candidate
                .plan
                .writes
                .iter()
                .filter(|change| change.before != change.after)
            {
                let file = self
                    .files
                    .entry(change.path.as_str().to_owned())
                    .or_insert(file_from_bytes(change.before.as_deref())?);
                file.draft = bytes_text(change.after.as_deref())?;
            }
            self.overlay = Some(Draft {
                owner: path.to_owned(),
                asset: asset.clone(),
            });
            next
        } else {
            owner.clone()
        };
        match target {
            Target::File if diagram_format(path) == Some(format) => {}
            Target::Asset { path }
                if next.document().assets.iter().any(|asset| {
                    &asset.path == path
                        && asset.source.is_some()
                        && diagram_format(path) == Some(format)
                }) => {}
            Target::Inline { from, to }
                if next.spans().iter().any(|span| {
                    span.asset_path.is_none()
                        && diagram::format(span.kind) == Some(format)
                        && ((span.start.0 == *from && span.end.0 == *to)
                            || (span.content_start.0 == *from && span.content_end.0 == *to))
                }) => {}
            Target::File | Target::Asset { .. } | Target::Inline { .. } => {
                return Err(ApiError::invalid("Цель не соответствует снимку диаграммы"));
            }
        }
        if let Target::Inline { from, to } = target {
            byte_range(next.source(), Utf16Offset(*from), Utf16Offset(*to))?;
        }
        for dependency in &next.document().assets {
            self.pin_dependency(state, &dependency.path)?;
        }
        Ok(())
    }

    pub fn load(&mut self, state: &State, path: &str) -> Result<(), ApiError> {
        note_path(path)?;
        if self.files.contains_key(path) {
            return Ok(());
        }
        let doc = state.require(path)?.document();
        self.record(state, path, Some(&doc.source))?;
        self.versions.insert(
            path.to_owned(),
            Base {
                revision: doc.page.revision,
                version: doc.version.clone(),
            },
        );
        for asset in &doc.assets {
            self.record(state, &asset.path, asset.source.as_deref())?;
        }
        Ok(())
    }

    fn record(&mut self, state: &State, path: &str, source: Option<&str>) -> Result<(), ApiError> {
        if let Some(file) = self.files.get(path) {
            if file.disk.as_deref() != source {
                return Err(state.stale(&[path], None));
            }
        } else {
            self.insert(path.to_owned(), file_from_bytes(source.map(str::as_bytes))?)?;
        }
        Ok(())
    }

    fn insert(&mut self, path: String, file: File) -> Result<(), ApiError> {
        if self.files.len() >= 128 {
            return Err(ApiError::invalid("Превышен лимит файлов в сообщении"));
        }
        self.files.insert(path, file);
        Ok(())
    }

    pub fn pin_dependency(&mut self, state: &State, path: &str) -> Result<(), ApiError> {
        if !self.files.contains_key(path) {
            user_path(path)?;
            let file = state.files.read_optional(path)?;
            self.insert(
                path.to_owned(),
                file_from_bytes(file.as_ref().map(|file| file.bytes.as_slice()))?,
            )?;
        }
        Ok(())
    }

    pub fn visible_sources(&self) -> BTreeMap<String, String> {
        self.files
            .iter()
            .filter_map(|(path, file)| {
                file.effective()
                    .map(|source| (path.clone(), source.to_owned()))
            })
            .collect()
    }

    pub fn source(&self, path: &str) -> Result<&str, ApiError> {
        self.effective_source(path)
            .ok_or_else(|| ApiError::not_found("Документ не найден"))
    }

    pub fn effective_source(&self, path: &str) -> Option<&str> {
        self.files.get(path).and_then(File::effective)
    }

    pub fn set_source(&mut self, path: &str, source: String) -> Result<(), ApiError> {
        text::check_size(source.len())?;
        let file = self
            .files
            .get_mut(path)
            .ok_or_else(|| ApiError::missing(path))?;
        file.staged = Some(source);
        Ok(())
    }

    pub fn editable_source(&self, path: &str) -> Result<std::borrow::Cow<'_, str>, ApiError> {
        let raw = self.source(path)?;
        if diagram_format(path) == Some(DiagramFormat::Drawio) {
            let page = self
                .files
                .get(path)
                .and_then(|file| file.editable_page.as_deref());
            return diagrams::expand_drawio(raw, page);
        }
        Ok(raw.into())
    }

    pub fn source_target(&self, path: &str, line: Option<NonZeroUsize>) -> NavigationTarget {
        // Развёрнутый XML draw.io не сохраняет номера строк файла.
        let line = if diagram_format(path) == Some(DiagramFormat::Drawio) {
            None
        } else {
            line
        };
        let pending = self.files.get(path).is_some_and(|file| file.disk.is_none());
        NavigationTarget::new(path.to_owned(), line, pending)
    }

    pub fn create(&mut self, path: String, source: String) -> Result<(), ApiError> {
        if self
            .files
            .get(&path)
            .is_some_and(|file| file.effective().is_some())
        {
            return Err(ApiError::destination(&path, "Файл уже подготовлен"));
        }
        let mut file = file_from_bytes(None)?;
        file.staged = Some(source);
        self.insert(path, file)
    }

    pub fn patch(
        &mut self,
        read: &Reading,
        patches: &[Patch],
        layout: Layout,
    ) -> Result<NavigationTarget, ApiError> {
        let source = self.editable_source(&read.path)?;
        let (next, line) = text::patch(&source, read, patches)?;
        let changed = next != source;
        let file = self
            .files
            .get_mut(&read.path)
            .ok_or_else(|| ApiError::not_found("Документ не найден"))?;
        if layout == Layout::Auto
            && (file.agent_base().is_some()
                || diagram_format(&read.path) != Some(DiagramFormat::Bpmn))
        {
            return Err(ApiError::invalid(
                "Автораскладка доступна только для нового BPMN",
            ));
        }
        if changed {
            file.staged = Some(next);
        }
        file.layout = layout;
        Ok(self.source_target(&read.path, line))
    }

    pub fn verify(&self, state: &State) -> Result<(), ApiError> {
        let mut stale = Vec::new();
        for dir in &self.new_directories {
            state.destination(dir.as_str(), None)?;
        }
        for (path, base) in &self.versions {
            if state.projection.document(path).is_none_or(|parsed| {
                let doc = parsed.document();
                doc.page.revision != base.revision || doc.version != base.version
            }) {
                stale.push(path.as_str());
            }
        }
        for (path, file) in &self.files {
            let disk = state.files.read_optional(path);
            if !disk.is_ok_and(|disk| {
                disk.as_ref().map(|item| item.bytes.as_slice())
                    == file.disk.as_deref().map(str::as_bytes)
            }) {
                stale.push(path.as_str());
            } else if file.disk.is_none() && file.effective().is_some() {
                let parent = path.rsplit_once('/').map(|(parent, _)| parent);
                if parent.is_some_and(|parent| {
                    self.new_directories
                        .iter()
                        .any(|dir| dir.as_str() == parent)
                }) {
                    empty_destination(state, path)?;
                } else {
                    new_destination(state, path)?;
                }
            }
        }
        if stale.is_empty() {
            return Ok(());
        }
        stale.sort_unstable();
        stale.dedup();
        Err(state.stale(&stale, None))
    }
}

fn require_base(state: &State, path: &str, base: &Base) -> Result<(), ApiError> {
    let expected = args::Expected {
        expected_revision: base.revision,
        expected_version: Some(base.version.clone()),
    };
    state.check(path, &expected).map(|_| ())
}

pub(super) fn parse<'a>(
    state: &State,
    path: &str,
    source: &str,
    mut prepared: impl FnMut(&str) -> Option<&'a str>,
) -> Result<ParsedDocument, ApiError> {
    Ok(parse_document(path, source, |path| {
        if let Some(source) = prepared(path) {
            return Ok(vault_read::AssetRead {
                source: source.to_owned(),
                version: Some(file_version(source.as_bytes())),
                modified: std::time::UNIX_EPOCH,
            });
        }
        Source(&state.files).asset(path)
    })?)
}

pub(super) fn diagram_format(path: &str) -> Option<DiagramFormat> {
    vault_read::diagram_format(path).map(|format| match format {
        vault_read::DiagramFormat::Mermaid => DiagramFormat::Mermaid,
        vault_read::DiagramFormat::Bpmn => DiagramFormat::Bpmn,
        vault_read::DiagramFormat::Drawio => DiagramFormat::Drawio,
    })
}

fn bytes_text(bytes: Option<&[u8]>) -> Result<Option<String>, ApiError> {
    bytes
        .map(|bytes| {
            text::check_size(bytes.len())?;
            let source = std::str::from_utf8(bytes)
                .map_err(|_| ApiError::invalid("Файл должен быть в UTF-8"))?;
            Ok(source.to_owned())
        })
        .transpose()
}

fn file_from_bytes(bytes: Option<&[u8]>) -> Result<File, ApiError> {
    Ok(File {
        disk: bytes_text(bytes)?,
        draft: None,
        staged: None,
        layout: Layout::Preserve,
        editable_page: None,
    })
}
