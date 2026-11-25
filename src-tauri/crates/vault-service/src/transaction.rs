use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vault_files::{
    DirectoryChange, FileWrite, PathRename, RelativePath, StagedTimes, VaultFileError, VaultFiles,
    VaultListing,
};
use vault_read::{FileTimes, ParsedDocument, StagedFile, VaultDocument, VaultProjection, sha256};

use crate::{
    ApiError,
    events::now_ms,
    source::{Source, problem, scan},
    state::{State, render_document},
};

pub struct Change {
    pub(crate) path: RelativePath,
    pub(crate) before: Option<Vec<u8>>,
    pub(crate) after: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct Plan {
    pub(crate) writes: Vec<Change>,
    pub(crate) directories: Vec<DirectoryChange>,
    pub(crate) rename: Option<PathRename>,
    // Скрытые вложения можно читать и проверять, но нельзя включать в запись.
    pub(crate) hidden_guards: Vec<Change>,
}

impl Change {
    pub(crate) fn new(
        path: &str,
        before: Option<Vec<u8>>,
        after: Option<Vec<u8>>,
    ) -> Result<Self, ApiError> {
        Ok(Self {
            path: RelativePath::new(path)?,
            before,
            after,
        })
    }
}

const RECEIPT_TTL_MS: u64 = 86_400_000;

pub struct ReceiptKey {
    path: RelativePath,
    signature: String,
    legacy: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Receipt {
    created: u64,
    signature: String,
    response: Value,
}

impl ReceiptKey {
    pub(crate) fn new(key: &str, operation: &str, args: Value) -> Result<Self, ApiError> {
        let path = RelativePath::new(&format!(
            ".livenote/requests/{}.json",
            sha256(key.as_bytes())
        ))?;
        let legacy = crate::receipt_signature::legacy(key, operation, &args)?;
        let mut args = args;
        if let Some(args) = args.as_object_mut() {
            args.remove("vault_id");
            args.remove("request_id");
            args.remove("requestId");
        }
        let signature = sha256(&serde_json::to_vec(&json!([operation, args]))?);
        Ok(Self {
            path,
            signature,
            legacy,
        })
    }

    fn encode(&self, response: &Value) -> Result<Vec<u8>, ApiError> {
        Ok(serde_json::to_vec(&Receipt {
            created: now_ms(),
            signature: self.signature.clone(),
            response: response.clone(),
        })?)
    }
}

impl State {
    pub(crate) fn replay(&self, key: Option<&ReceiptKey>) -> Result<Option<Value>, ApiError> {
        let Some(key) = key else { return Ok(None) };
        let Some(file) = self.files.read_optional(key.path.as_str())? else {
            return Ok(None);
        };
        let receipt: Receipt = serde_json::from_slice(&file.bytes)?;
        if now_ms().saturating_sub(receipt.created) > RECEIPT_TTL_MS {
            return Ok(None);
        }
        if receipt.signature != key.signature && key.legacy.as_ref() != Some(&receipt.signature) {
            return Err(ApiError::new(
                409,
                "idempotency_key_reuse",
                "requestId уже использован с другими параметрами",
            ));
        }
        Ok(Some(receipt.response))
    }

    pub(crate) fn persist_receipt(
        &self,
        plan: &mut Plan,
        receipt: (&ReceiptKey, &Value),
    ) -> Result<(), ApiError> {
        let (key, response) = receipt;
        let previous = self
            .files
            .read_optional(key.path.as_str())?
            .map(|file| file.bytes);
        plan.writes.push(Change {
            path: key.path.clone(),
            before: previous,
            after: Some(key.encode(response)?),
        });
        Ok(())
    }

    pub(crate) fn preview(&self, path: &str, plan: &Plan) -> Result<ParsedDocument, ApiError> {
        preview(&self.files, &self.listing, path, plan, &[])
    }

    pub(crate) fn commit(&mut self, plan: &Plan, primary: &str) -> Result<bool, ApiError> {
        self.check_hidden_guards(plan, primary)?;
        let writes = plan.file_writes();
        let result = self
            .files
            .commit(&writes, &plan.directories, plan.rename.as_ref());
        let changed = self.commit_result(result, primary)?;
        if changed {
            self.refresh(false)?;
        }
        Ok(changed)
    }

    pub(crate) fn commit_document_receipt(
        &mut self,
        plan: &Plan,
        path: &str,
        key: &ReceiptKey,
        response: impl FnOnce(VaultDocument) -> Result<Value, ApiError>,
    ) -> Result<Value, ApiError> {
        self.check_hidden_guards(plan, path)?;
        let writes = plan.file_writes();
        let listing = &self.listing;
        let confirmations = self.renders.get(path);
        let result = self
            .files
            .commit_with_receipt(&writes, &key.path, |files, times| {
                let document = preview(files, listing, path, plan, times)?;
                let response = response(render_document(document.into_document(), confirmations))?;
                Ok::<_, ApiError>((key.encode(&response)?, response))
            });
        let response = self.commit_result(result, path)??;
        self.refresh(false)?;
        Ok(response)
    }

    fn check_hidden_guards(&self, plan: &Plan, primary: &str) -> Result<(), ApiError> {
        for guard in &plan.hidden_guards {
            let current = self
                .files
                .read_optional(guard.path.as_str())?
                .map(|file| file.bytes);
            if current != guard.before {
                return Err(self.stale(
                    &[guard.path.as_str()],
                    self.projection
                        .document(primary)
                        .map(ParsedDocument::document),
                ));
            }
        }
        Ok(())
    }

    fn commit_result<T>(
        &mut self,
        result: Result<T, VaultFileError>,
        primary: &str,
    ) -> Result<T, ApiError> {
        match result {
            Ok(value) => Ok(value),
            Err(VaultFileError::Stale { path }) => {
                self.refresh(true)?;
                Err(self.stale(
                    &[&path],
                    self.projection
                        .document(primary)
                        .map(ParsedDocument::document),
                ))
            }
            Err(error) => Err(error.into()),
        }
    }
}

impl Plan {
    fn file_writes(&self) -> Vec<FileWrite<'_>> {
        self.writes
            .iter()
            .map(|item| FileWrite {
                path: item.path.clone(),
                source: item.after.as_deref(),
                expected: item.before.as_deref(),
            })
            .collect()
    }
}

fn preview(
    files: &VaultFiles,
    listing: &VaultListing,
    path: &str,
    plan: &Plan,
    times: &[StagedTimes<'_>],
) -> Result<ParsedDocument, ApiError> {
    let problems = listing.problems.iter().map(problem).collect::<Vec<_>>();
    let recovery = files
        .recovery_problems()
        .iter()
        .map(problem)
        .collect::<Vec<_>>();
    let staged = plan
        .writes
        .iter()
        .filter(|change| change.before != change.after)
        .map(|item| StagedFile {
            path: item.path.as_str(),
            source: item.after.as_deref(),
        })
        .collect::<Vec<_>>();
    let mut projection = VaultProjection::new();
    let scan = scan(listing, (&problems, &recovery));
    projection.reconcile_staged_with_times(scan, &Source(files), &staged, |path| {
        times
            .iter()
            .find(|item| item.path.as_str() == path)
            .map_or_else(FileTimes::default, |item| FileTimes {
                created: item.created,
                modified: item.modified,
            })
    });
    projection.document(path).cloned().ok_or_else(|| {
        projection
            .problems()
            .iter()
            .find(|problem| problem.path == path)
            .cloned()
            .map_or_else(
                || ApiError::not_found("Документ не найден в подготовленной записи"),
                ApiError::from,
            )
    })
}
