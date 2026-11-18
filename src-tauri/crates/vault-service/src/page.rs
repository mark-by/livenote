use crate::{
    ApiError,
    args::{Delete, Expected, Update, WriteDocument},
    edit::{renamed, reorder},
    state::State,
    transaction::{Change, Plan},
    tree::Move,
};
use vault_read::PageFull;
impl State {
    pub(crate) fn update(
        &mut self,
        args: Update,
        deleted_block: Option<&str>,
    ) -> Result<PageFull, ApiError> {
        let doc = self.check(&args.page_id, &args.expected)?;
        let deleted = args.delete_block_ids.as_deref().unwrap_or_default();
        let source = reorder(doc, deleted, args.block_order.as_deref())?;
        if let Some(path) = args
            .title
            .as_deref()
            .map(|title| renamed(&args.page_id, title))
            .filter(|path| path != &args.page_id)
        {
            self.move_path(
                &args.page_id,
                &path,
                Move::Document {
                    expected: &args.expected,
                    source: Some(&source),
                },
            )?;
            let page = self.render_fields(self.require(&path)?.document()).page;
            self.emit("page.updated", &path, page.revision);
            return Ok(page);
        }
        let version = doc.document().version.clone();
        let request = WriteDocument {
            path: args.page_id,
            expected: Expected {
                expected_version: Some(version),
                ..args.expected
            },
            source,
            assets: Vec::new(),
            references: Vec::new(),
            request_id: None,
        };
        let candidate = self.write_document(&request, false)?;
        let before = self.revisions();
        self.commit(&candidate.plan, &request.path)?;
        let page = self
            .render_fields(self.require(&request.path)?.document())
            .page;
        if let Some(id) = deleted_block {
            self.block_event("block.deleted", &request.path, id, page.revision);
        } else if before.get(&request.path) != Some(&page.revision) {
            self.emit("page.updated", &request.path, page.revision);
        }
        self.related(&before, &request.path);
        Ok(page)
    }

    pub(crate) fn delete_page(&mut self, args: &Delete) -> Result<(), ApiError> {
        let doc = self.check(&args.page_id, &args.expected)?.document();
        let mut plan = Plan::default();
        plan.writes.push(Change::new(
            &args.page_id,
            Some(doc.source.as_bytes().to_vec()),
            None,
        )?);
        self.collect_unused(&mut plan, doc, None)?;
        self.commit(&plan, &args.page_id)?;
        self.emit(
            "page.deleted",
            &args.page_id,
            args.expected.expected_revision,
        );
        Ok(())
    }
}
