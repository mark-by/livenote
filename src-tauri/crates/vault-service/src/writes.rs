use crate::{
    ApiError, Output, args,
    block::{BlockSummary, Mode},
    registry::Entry,
    service::{Service, access, decode, require_version},
    transaction::ReceiptKey,
};
use serde_json::Value;
use std::sync::Arc;
impl Service {
    pub(crate) async fn document_action(
        &self,
        entry: Arc<Entry>,
        operation: &str,
        args: Value,
    ) -> Result<Output, ApiError> {
        use crate::document::Candidate;
        enum Prepared {
            Replay(Value),
            Write(Box<Candidate>, Option<ReceiptKey>),
        }
        let operation = operation.to_owned();
        let prepared = access(Arc::clone(&entry), move |state| {
            let request_id: Option<String> = args
                .get("request_id")
                .or_else(|| args.get("requestId"))
                .cloned()
                .map(decode)
                .transpose()?
                .flatten();
            let receipt = request_id
                .as_deref()
                .map(|id| ReceiptKey::new(id, &operation, args.clone()))
                .transpose()?;
            if let Some(replay) = state.replay(receipt.as_ref())? {
                return Ok(Prepared::Replay(replay));
            }
            let candidate = match operation.as_str() {
                "add_page" => {
                    let create: args::Create = decode(args)?;
                    debug_assert_eq!(create.request_id, request_id);
                    state.create(&create)?
                }
                "import_markdown" => {
                    let args::Import {
                        content,
                        title,
                        path,
                    } = decode(args)?;
                    state.create(&args::Create {
                        title: title.unwrap_or_else(|| "Импортированная заметка".to_owned()),
                        path,
                        source: Some(content),
                        format: None,
                        request_id: None,
                        aliases: None,
                        tags: None,
                    })?
                }
                "write_document" => {
                    let body: args::WriteDocument = decode(args)?;
                    debug_assert_eq!(body.request_id, request_id);
                    require_version(&body.expected)?;
                    state.write_document(&body, true)?
                }
                _ => return Err(ApiError::not_found("Операция не найдена")),
            };
            Ok(Prepared::Write(Box::new(candidate), receipt))
        })
        .await?;
        let (mut candidate, receipt) = match prepared {
            Prepared::Replay(replay) => return Ok(Output::Json(replay)),
            Prepared::Write(candidate, receipt) => (candidate, receipt),
        };
        candidate.validate(&self.validator).await?;
        access(entry, move |state| {
            state
                .finish_document(*candidate, receipt.as_ref())
                .map(Output::Json)
        })
        .await
    }

    pub(crate) async fn block_action<T: Send + 'static>(
        &self,
        entry: Arc<Entry>,
        operation: &str,
        args: Value,
        response: fn(&crate::state::State, BlockSummary) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        use crate::block::BlockWrite;
        enum Prepared<T> {
            Replay(T),
            Write(Box<BlockWrite>, Option<ReceiptKey>),
        }
        let mode = match operation {
            "write_markdown" => Mode::Markdown,
            "write_diagram" => Mode::Diagram,
            "replace_block" => Mode::Replace,
            "layout_diagram" => Mode::Layout,
            _ => return Err(ApiError::not_found("Операция не найдена")),
        };
        let operation = operation.to_owned();
        let prepared = access(Arc::clone(&entry), move |state| {
            let body: args::WriteBlock = match mode {
                Mode::Layout => {
                    let args::LayoutDiagram {
                        page_id,
                        block_id,
                        expected,
                    } = decode(args.clone())?;
                    args::WriteBlock {
                        page_id,
                        block_id: Some(block_id),
                        expected,
                        source: String::new(),
                        format: None,
                        title: None,
                        at: None,
                        request_id: None,
                        layout: args::Layout::Auto,
                    }
                }
                Mode::Markdown | Mode::Diagram | Mode::Replace => decode(args.clone())?,
            };
            let receipt = body
                .request_id
                .as_deref()
                .map(|id| ReceiptKey::new(id, &operation, args))
                .transpose()?;
            if let Some(replay) = state.replay(receipt.as_ref())? {
                return response(state, serde_json::from_value(replay)?).map(Prepared::Replay);
            }
            state
                .prepare_block(body, mode)
                .map(|write| Prepared::Write(Box::new(write), receipt))
        })
        .await?;
        let (write, receipt) = match prepared {
            Prepared::Replay(replay) => return Ok(replay),
            Prepared::Write(write, receipt) => (write, receipt),
        };
        self.publish_block(entry, *write, receipt, response).await
    }

    async fn publish_block<T: Send + 'static>(
        &self,
        entry: Arc<Entry>,
        mut write: crate::block::BlockWrite,
        receipt: Option<ReceiptKey>,
        response: fn(&crate::state::State, BlockSummary) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        use crate::{block::Publication, diagram::invalid};
        use livenote_diagrams::ValidationStatus;
        let validation = write.validate(&self.validator).await?;
        let path = write.body.page_id.clone();
        let prior_id = write.body.block_id.clone();
        let expected = write.body.expected.clone();
        if validation
            .as_ref()
            .is_some_and(|check| check.syntax != ValidationStatus::Ok)
        {
            return access(entry, move |state| {
                let revision = state.check(&path, &expected)?.document().page.revision;
                let summary = BlockSummary {
                    page_id: path,
                    block_id: prior_id.unwrap_or_default(),
                    revision,
                    validation,
                };
                response(state, summary)
            })
            .await;
        }
        let edit = access(Arc::clone(&entry), move |state| {
            state.edit_block(write.body, write.kind)
        })
        .await?;
        for check in &edit.checks {
            let validation = self
                .validator
                .validate(check.format, &check.source, args::Layout::Preserve)
                .await
                .1;
            if validation.syntax != ValidationStatus::Ok {
                return Err(invalid(&check.block, Some(&validation)));
            }
        }
        let publication = Publication {
            path,
            expected,
            prior_id,
            edit,
            validation,
            receipt,
        };
        access(entry, move |state| {
            let summary = state.finish_block(publication)?;
            response(state, summary)
        })
        .await
    }
}
