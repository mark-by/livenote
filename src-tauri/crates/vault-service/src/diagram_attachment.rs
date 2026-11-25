use livenote_diagrams::DiagramFormat;

use crate::{
    ApiError,
    edit::{escape_label, safe_title},
    links::{UrlStyle, relative_url},
    state::State,
};

#[derive(Clone, Copy)]
pub enum AttachmentFormat {
    Bpmn,
    Drawio,
}

impl AttachmentFormat {
    pub const fn for_diagram(format: DiagramFormat) -> Option<Self> {
        match format {
            DiagramFormat::Mermaid => None,
            DiagramFormat::Bpmn => Some(Self::Bpmn),
            DiagramFormat::Drawio => Some(Self::Drawio),
        }
    }
}

pub struct Attachment<'a> {
    pub(crate) page_path: &'a str,
    pub(crate) page_title: &'a str,
    pub(crate) title: Option<&'a str>,
    pub(crate) format: AttachmentFormat,
}

impl Attachment<'_> {
    pub(crate) fn choose_path(
        &self,
        state: &State,
        reserved: impl Fn(&str) -> bool,
    ) -> Result<String, ApiError> {
        let ext = match self.format {
            AttachmentFormat::Bpmn => "bpmn",
            AttachmentFormat::Drawio => "drawio",
        };
        let label = self.title.filter(|label| !label.is_empty()).unwrap_or(ext);
        let mut base = safe_title(&format!("{} — {label}", self.page_title));
        // Оставляем место для номера и расширения в имени файла.
        if let Some((at, _)) = base
            .char_indices()
            .find(|(at, ch)| at + ch.len_utf8() > 240)
        {
            base.truncate(at);
        }
        let base = format!("{}/{base}", self.directory());
        state.unique_with(&base, ext, reserved)
    }

    pub(crate) fn directory(&self) -> String {
        self.page_path.rsplit_once('/').map_or_else(
            || "Схемы".to_owned(),
            |(parent, _)| format!("{parent}/Схемы"),
        )
    }

    pub(crate) fn embed(&self, path: &str, nl: &str) -> String {
        let url = relative_url(self.page_path, path, UrlStyle::default());
        let label = escape_label(self.title.unwrap_or_default());
        format!("![{label}]({url}){nl}")
    }
}
