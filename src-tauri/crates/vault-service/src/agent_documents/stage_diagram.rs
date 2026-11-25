use std::{collections::BTreeSet, num::NonZeroUsize, sync::Arc};

use livenote_diagrams::ValidationStatus;
use vault_read::{ParsedDocument, Utf16Offset};

use crate::{
    ApiError,
    args::Layout,
    diagram::{Validator, format, invalid},
    diagram_attachment::{Attachment, AttachmentFormat},
    edit::{block_title, byte_at, fence},
    service::access,
    state::{State, note_path, user_path},
    tree::fold,
};

use super::{
    DiagramFormat, DiagramValidation, DocTurn, StageDiagram, StagedDiagram, snapshot, text,
};
use snapshot::Snapshot;

impl DocTurn {
    /// Проверяет и добавляет диаграмму в снимок сообщения. Не пишет файлы.
    ///
    /// # Errors
    /// Возвращает ошибку пути, размера, вставки или проверки диаграммы.
    /// После ошибки проверки публикация требует успешного повтора для той же страницы.
    pub async fn stage_diagram(&mut self, input: StageDiagram) -> Result<StagedDiagram, ApiError> {
        note_path(&input.page_path)?;
        if snapshot::diagram_format(&input.page_path).is_some() || input.source.trim().is_empty() {
            return Err(ApiError::invalid(
                "Укажите страницу Markdown и непустой исходник диаграммы",
            ));
        }
        text::check_size(input.source.len())?;
        let snapshot = self.snapshot.clone();
        let prepared = access(Arc::clone(&self.vault.entry), move |state| {
            PreparedDiagram::build(state, snapshot, input)
        })
        .await?;
        let (laid_out, validation) = prepared.validate(&self.vault.validator).await;
        let PreparedDiagram {
            mut snapshot,
            page_path,
            asset_path,
            line,
            ..
        } = prepared;
        if validation.syntax != ValidationStatus::Ok {
            let error = invalid(&page_path, Some(&validation));
            self.diagram_failures.insert(page_path, validation);
            return Err(error);
        }
        if let (Some(path), Some(source)) = (&asset_path, laid_out) {
            snapshot.set_source(path, source)?;
        }
        let target = snapshot.source_target(&page_path, line);
        self.snapshot = snapshot;
        self.diagram_failures.remove(&page_path);
        Ok(StagedDiagram {
            page_path,
            asset_path,
            validation,
            target,
        })
    }
}

struct PreparedDiagram {
    snapshot: Snapshot,
    page_path: String,
    asset_path: Option<String>,
    line: Option<NonZeroUsize>,
    format: DiagramFormat,
    source: String,
}

impl PreparedDiagram {
    fn build(state: &State, mut snapshot: Snapshot, input: StageDiagram) -> Result<Self, ApiError> {
        let StageDiagram {
            page_path,
            format: kind,
            source,
            title,
        } = input;
        snapshot.load(state, &page_path)?;
        let page = snapshot.source(&page_path)?;
        let before = snapshot::parse(state, &page_path, page, |path| {
            snapshot.effective_source(path)
        })?;
        let title = title.as_deref().map(block_title);
        let nl = before.newline();
        let (block, asset_path) = if let Some(format) = AttachmentFormat::for_diagram(kind) {
            let attachment = Attachment {
                page_path: &page_path,
                page_title: &before.document().page.title,
                title: title.as_deref(),
                format,
            };
            let path = snapshot.stage_attachment(state, &attachment, source)?;
            let block = attachment.embed(&path, nl);
            (block, Some(path))
        } else {
            (fence(&source, title.as_deref(), nl), None)
        };

        let page = before.source();
        let next = append(page, &block, nl)?;
        let parsed = snapshot::parse(state, &page_path, &next, |path| {
            snapshot.effective_source(path)
        })?;
        let start = Utf16Offset(page.encode_utf16().count());
        let (source, line) = appended(&parsed, (kind, asset_path.as_deref()), start)?;
        snapshot.set_source(&page_path, next)?;
        Ok(Self {
            snapshot,
            page_path,
            asset_path,
            line,
            format: kind,
            source,
        })
    }

    async fn validate(&self, validator: &Validator) -> (Option<String>, DiagramValidation) {
        let layout = match self.format {
            DiagramFormat::Bpmn => Layout::Auto,
            DiagramFormat::Mermaid | DiagramFormat::Drawio => Layout::Preserve,
        };
        validator.validate(self.format, &self.source, layout).await
    }
}

impl Snapshot {
    fn stage_attachment(
        &mut self,
        state: &State,
        attachment: &Attachment<'_>,
        source: String,
    ) -> Result<String, ApiError> {
        let directory = attachment.directory();
        if !state.listing.folders.contains(&directory) {
            state.destination(&directory, None)?;
            self.new_directories.insert(user_path(&directory)?);
        }
        let reserved = self
            .files
            .keys()
            .map(|path| fold(path))
            .collect::<BTreeSet<_>>();
        let path = attachment.choose_path(state, |path| reserved.contains(&fold(path)))?;
        self.create(path.clone(), source)?;
        self.managed_assets
            .insert(path.clone(), attachment.page_path.to_owned());
        Ok(path)
    }
}

fn append(page: &str, block: &str, nl: &str) -> Result<String, ApiError> {
    let separator = if page.is_empty() || page == "\u{feff}" {
        ""
    } else {
        nl
    };
    let end_line = if !separator.is_empty() && !page.ends_with('\n') {
        nl
    } else {
        ""
    };
    text::check_size(page.len() + block.len() + end_line.len() + separator.len())?;
    Ok(format!("{page}{end_line}{separator}{block}"))
}

fn appended(
    parsed: &ParsedDocument,
    expected: (DiagramFormat, Option<&str>),
    start: Utf16Offset,
) -> Result<(String, Option<NonZeroUsize>), ApiError> {
    let (kind, asset) = expected;
    parsed
        .spans()
        .iter()
        .zip(&parsed.document().page.blocks)
        .find(|(span, _)| {
            span.start >= start
                && format(span.kind) == Some(kind)
                && span.asset_path.as_deref() == asset
        })
        .map(|(span, block)| {
            let source = parsed.source();
            let line = match byte_at(source, span.start) {
                Ok(offset) => source.get(..offset).map(text::line_after),
                Err(_) => None,
            };
            (block.source.clone(), line)
        })
        .ok_or_else(|| ApiError::invalid("Не удалось добавить блок диаграммы в конец страницы"))
}
