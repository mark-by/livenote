use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vault_files::{DirectoryChange, FileWrite, PathRename, RelativePath, VaultFileError};
use vault_read::{ParsedDocument, StagedFile, VaultProjection, sha256};

use crate::{
    ApiError,
    events::now_ms,
    source::{Source, problem, scan},
    state::State,
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
    path: String,
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
        let path = format!(".livenote/requests/{}.json", sha256(key.as_bytes()));
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
}

impl State {
    pub(crate) fn replay(&self, key: Option<&ReceiptKey>) -> Result<Option<Value>, ApiError> {
        let Some(key) = key else { return Ok(None) };
        let Some(file) = self.files.read_optional(&key.path)? else {
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
        let previous = self.files.read_optional(&key.path)?.map(|file| file.bytes);
        let next = serde_json::to_vec(&Receipt {
            created: now_ms(),
            signature: key.signature.clone(),
            response: response.clone(),
        })?;
        plan.writes
            .push(Change::new(&key.path, previous, Some(next))?);
        Ok(())
    }

    pub(crate) fn preview(&self, path: &str, plan: &Plan) -> Result<ParsedDocument, ApiError> {
        let problems = self
            .listing
            .problems
            .iter()
            .map(problem)
            .collect::<Vec<_>>();
        let recovery = self
            .files
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
        let scan = scan(&self.listing, (&problems, &recovery));
        projection.reconcile_staged(scan, &Source(&self.files), &staged);
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

    pub(crate) fn commit(&mut self, plan: &Plan, primary: &str) -> Result<bool, ApiError> {
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
        let writes = plan
            .writes
            .iter()
            .map(|item| FileWrite {
                path: item.path.clone(),
                source: item.after.as_deref(),
                expected: item.before.as_deref(),
            })
            .collect::<Vec<_>>();
        let changed = match self
            .files
            .commit(&writes, &plan.directories, plan.rename.as_ref())
        {
            Ok(changed) => changed,
            Err(VaultFileError::Stale { path }) => {
                self.refresh(true)?;
                return Err(self.stale(
                    &[&path],
                    self.projection
                        .document(primary)
                        .map(ParsedDocument::document),
                ));
            }
            Err(error) => return Err(error.into()),
        };
        if changed {
            self.refresh(false)?;
        }
        Ok(changed)
    }
}
