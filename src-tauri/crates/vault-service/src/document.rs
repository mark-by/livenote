use std::collections::BTreeSet;

use livenote_diagrams::ValidationStatus;
use serde_json::Value;
use vault_read::{diagram_format, file_version, parse_document};

use crate::{
    ApiError,
    args::{Create, Expected, WriteDocument},
    assets::Check,
    diagram::{Validator, invalid},
    edit::safe_title,
    source::Source,
    state::{State, note_path, user_path},
    transaction::{Change, Plan, ReceiptKey},
};

pub struct Candidate {
    pub(crate) path: String,
    expected: Option<Expected>,
    pub(crate) plan: Plan,
    pub(crate) checks: Vec<Check>,
}

impl Candidate {
    pub(crate) async fn validate(&mut self, validator: &Validator) -> Result<(), ApiError> {
        for check in &self.checks {
            let (source, validation) = validator
                .validate(check.format, &check.source, check.layout)
                .await;
            if validation.syntax != ValidationStatus::Ok {
                return Err(invalid(&check.block, Some(&validation)));
            }
            if let Some(source) = source {
                let target = self
                    .plan
                    .writes
                    .iter_mut()
                    .find(|write| write.path.as_str() == check.path)
                    .ok_or_else(|| {
                        ApiError::invalid("Для раскладки требуется запись файла диаграммы")
                    })?;
                target.after = Some(source.into_bytes());
            }
        }
        Ok(())
    }
}

impl State {
    pub(crate) fn create(&self, body: &Create) -> Result<Candidate, ApiError> {
        if body.aliases.is_some() || body.tags.is_some() {
            return Err(ApiError::invalid("Метаданные задаются в source заметки"));
        }
        let ext = match body.format {
            Some(vault_read::DiagramFormat::Mermaid) => "mmd",
            Some(vault_read::DiagramFormat::Bpmn) => "bpmn",
            Some(vault_read::DiagramFormat::Drawio) => "drawio",
            None => "md",
        };
        let path = match &body.path {
            Some(path) => {
                self.destination(path, None)?;
                path.clone()
            }
            None => self.unique(&safe_title(&body.title), ext)?,
        };
        note_path(&path)?;
        if body.format.is_some() && body.format != diagram_format(&path) {
            return Err(ApiError::invalid("Формат не соответствует расширению"));
        }
        if diagram_format(&path).is_some() && body.source.is_none() {
            return Err(ApiError::invalid("Для диаграммы требуется source"));
        }
        let source = body.source.as_deref().unwrap_or_default();
        let mut plan = Plan::default();
        plan.writes
            .push(Change::new(&path, None, Some(source.as_bytes().to_vec()))?);
        let next = parse_document(&path, source, |asset| Source(&self.files).asset(asset))?;
        let checks = self.checks(&mut plan, &next, None, None)?;
        Ok(Candidate {
            path,
            expected: None,
            plan,
            checks,
        })
    }

    pub(crate) fn write_document(
        &self,
        body: &WriteDocument,
        validate: bool,
    ) -> Result<Candidate, ApiError> {
        let old = self.check(&body.path, &body.expected)?.document();
        let mut plan = Plan::default();
        plan.writes.push(Change::new(
            &body.path,
            Some(old.source.as_bytes().to_vec()),
            Some(body.source.as_bytes().to_vec()),
        )?);
        let mut seen = BTreeSet::new();
        for asset in &body.assets {
            user_path(&asset.path)?;
            if diagram_format(&asset.path).is_none()
                || !seen.insert(&asset.path)
                || diagram_format(&body.path).is_some()
            {
                return Err(ApiError::invalid("Некорректный asset"));
            }
            let prior = self
                .files
                .read_optional(&asset.path)?
                .map(|file| file.bytes);
            if prior.as_deref().map(file_version) != asset.expected_version {
                return Err(self.stale(&[&asset.path], Some(old)));
            }
            if prior.is_none() {
                self.destination(&asset.path, None)?;
            }
            plan.writes.push(Change::new(
                &asset.path,
                prior,
                Some(asset.source.as_bytes().to_vec()),
            )?);
        }
        let next = parse_document(&body.path, &body.source, |path| {
            if let Some(asset) = body.assets.iter().find(|asset| asset.path == path) {
                return Ok(vault_read::AssetRead {
                    source: asset.source.clone(),
                    version: Some(file_version(asset.source.as_bytes())),
                    modified: std::time::UNIX_EPOCH,
                });
            }
            Source(&self.files).asset(path)
        })?;
        let new = next.document();
        if body
            .assets
            .iter()
            .any(|asset| !new.assets.iter().any(|linked| linked.path == asset.path))
        {
            return Err(ApiError::invalid("Asset должен быть встроен в документ"));
        }
        let mut refs = BTreeSet::new();
        for reference in &body.references {
            user_path(&reference.path)?;
            let asset = new
                .assets
                .iter()
                .find(|asset| asset.path == reference.path)
                .filter(|_| refs.insert(&reference.path))
                .ok_or_else(|| ApiError::invalid("Некорректная reference"))?;
            let prior = plan
                .writes
                .iter()
                .find(|item| item.path.as_str() == reference.path)
                .map_or_else(
                    || asset.version.clone(),
                    |item| item.before.as_deref().map(file_version),
                );
            if prior.as_ref() != Some(&reference.expected_version) {
                return Err(self.stale(&[&reference.path], Some(old)));
            }
        }
        let checks = if validate {
            self.checks(&mut plan, &next, Some(old), Some(body))?
        } else {
            self.asset_guards(&mut plan, new)?;
            Vec::new()
        };
        if !validate {
            self.collect_unused(&mut plan, old, Some(new))?;
        }
        let mut expected = body.expected.clone();
        expected.expected_version = Some(old.version.clone());
        Ok(Candidate {
            path: body.path.clone(),
            expected: Some(expected),
            plan,
            checks,
        })
    }

    pub(crate) fn finish_document(
        &mut self,
        mut candidate: Candidate,
        receipt: Option<&ReceiptKey>,
    ) -> Result<Value, ApiError> {
        if let Some(replay) = self.replay(receipt)? {
            return Ok(replay);
        }
        let path = &candidate.path;
        let previous = candidate
            .expected
            .as_ref()
            .map(|expected| self.check(path, expected))
            .transpose()?;
        let before = self.revisions();
        let (response, creating) = {
            let preview = self.preview(path, &candidate.plan)?;
            if let Some(old) = previous {
                self.collect_unused(
                    &mut candidate.plan,
                    old.document(),
                    Some(preview.document()),
                )?;
            }
            let creating = candidate.expected.is_none();
            let document = self.render_fields(preview.document());
            let response = if creating {
                serde_json::to_value(document.page)?
            } else {
                serde_json::to_value(document)?
            };
            (response, creating)
        };
        if let Some(key) = receipt {
            self.persist_receipt(&mut candidate.plan, (key, &response))?;
        }
        self.commit(&candidate.plan, path)?;
        let document = self.render_fields(self.require(path)?.document());
        if before.get(path) != Some(&document.page.revision) {
            self.emit(
                if creating {
                    "page.created"
                } else {
                    "page.updated"
                },
                path,
                document.page.revision,
            );
        }
        self.related(&before, path);
        if receipt.is_some() {
            Ok(response)
        } else if creating {
            Ok(serde_json::to_value(document.page)?)
        } else {
            Ok(serde_json::to_value(document)?)
        }
    }
}
