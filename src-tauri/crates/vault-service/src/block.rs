use livenote_diagrams::{DiagramValidation, ValidationStatus};
use serde_json::{Value, json};
use vault_read::BlockType;

use crate::{
    ApiError,
    args::{Expected, Layout, WriteBlock},
    block_edit::Edit,
    diagram::{Validator, format, invalid, result},
    events::{event, publish},
    state::State,
    transaction::ReceiptKey,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Markdown,
    Diagram,
    Replace,
    Layout,
}

pub struct BlockWrite {
    pub(crate) body: WriteBlock,
    pub(crate) kind: BlockType,
    pub(crate) mode: Mode,
}

pub struct Publication {
    pub(crate) path: String,
    pub(crate) expected: Expected,
    pub(crate) prior_id: Option<String>,
    pub(crate) edit: Edit,
    pub(crate) validation: Option<DiagramValidation>,
    pub(crate) receipt: Option<ReceiptKey>,
}

impl BlockWrite {
    pub(crate) async fn validate(
        &mut self,
        validator: &Validator,
    ) -> Result<Option<DiagramValidation>, ApiError> {
        let Some(kind) = format(self.kind) else {
            return Ok(None);
        };
        let (source, validation) = validator
            .validate(kind, &self.body.source, self.body.layout)
            .await;
        if let Some(source) = source {
            self.body.source = source;
        }
        if self.mode == Mode::Layout && validation.syntax != ValidationStatus::Ok {
            return Err(invalid(
                self.body.block_id.as_deref().unwrap_or_default(),
                Some(&validation),
            ));
        }
        Ok(Some(validation))
    }
}

impl State {
    pub(crate) fn prepare_block(
        &self,
        mut body: WriteBlock,
        mode: Mode,
    ) -> Result<BlockWrite, ApiError> {
        let current = self.check(&body.page_id, &body.expected)?.document();
        body.expected.expected_version = Some(current.version.clone());
        let existing = body
            .block_id
            .as_ref()
            .map(|id| {
                current
                    .page
                    .blocks
                    .iter()
                    .find(|block| &block.id == id)
                    .ok_or_else(|| ApiError::block(&body.page_id, id))
            })
            .transpose()?;
        let kind = match mode {
            Mode::Markdown => BlockType::Markdown,
            Mode::Diagram => {
                BlockType::from(body.format.unwrap_or(vault_read::DiagramFormat::Mermaid))
            }
            Mode::Replace => {
                existing
                    .ok_or_else(|| ApiError::invalid("Требуется block_id"))?
                    .kind
            }
            Mode::Layout => {
                let old = existing
                    .filter(|block| block.kind == BlockType::Bpmn)
                    .ok_or_else(|| ApiError::invalid("Раскладка доступна только для BPMN"))?;
                body.source.clone_from(&old.source);
                body.layout = Layout::Auto;
                BlockType::Bpmn
            }
        };
        if kind != BlockType::Markdown && body.source.trim().is_empty() {
            return Err(ApiError::invalid("source не может быть пустым"));
        }
        Ok(BlockWrite { body, kind, mode })
    }

    pub(crate) fn finish_block(&mut self, publication: Publication) -> Result<Value, ApiError> {
        let Publication {
            path,
            expected,
            prior_id,
            edit,
            validation,
            receipt,
        } = publication;
        if let Some(replay) = self.replay(receipt.as_ref())? {
            return Ok(replay);
        }
        let previous = self.check(&path, &expected)?;
        let Edit {
            mut plan,
            id,
            revision,
            ..
        } = edit;
        if !plan.writes.is_empty() {
            let next = self.preview(&path, &plan)?;
            self.collect_unused(&mut plan, previous.document(), Some(next.document()))?;
        }
        let response = result(&path, &id, revision, validation.as_ref());
        if let Some(key) = receipt.as_ref() {
            self.persist_receipt(&mut plan, (key, &response))?;
        }
        let before = self.revisions();
        if self.commit(&plan, &path)? && before.get(&path) != Some(&revision) {
            let kind = if prior_id.is_some() {
                "block.updated"
            } else {
                "block.created"
            };
            self.block_event(kind, &path, &id, revision);
            self.related(&before, &path);
        }
        Ok(response)
    }

    pub(crate) fn block_event(&self, kind: &str, path: &str, id: &str, revision: u64) {
        let mut payload = event(kind, path, revision);
        payload.insert("origin".into(), json!("api"));
        if !id.is_empty() {
            payload.insert("blockId".into(), json!(id));
        }
        publish(&self.events, payload);
    }
}
