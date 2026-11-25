use livenote_vault_service::agent_documents as d;

use super::types::{Error, Paths, Result};
use crate::agent_bindings as b;

pub(super) struct BindingVault(pub d::VaultRef);

impl b::BindingVault for BindingVault {
    fn vault_id(&self) -> &str {
        self.0.id()
    }

    fn read_bindings(&self) -> b::BindingResult<Option<b::VersionedBytes>> {
        self.0
            .read_bindings_blocking()
            .map(|file| {
                file.map(|file| b::VersionedBytes {
                    version: file.version,
                    bytes: file.bytes,
                })
            })
            .map_err(binding_error)
    }

    fn write_bindings(&self, update: b::CasBytes) -> b::BindingResult<b::Version> {
        self.0
            .write_bindings_blocking(d::CasBytes {
                expected_version: update.expected,
                bytes: update.bytes,
            })
            .map_err(binding_error)
    }
}

fn binding_error(error: livenote_vault_service::ApiError) -> b::BindingError {
    match error.status {
        409 => b::BindingError::new("conflict", "Файл привязок изменился"),
        _ => b::BindingError::new("storage", "Файл привязок недоступен"),
    }
}

pub(super) async fn blocking<T: Send + 'static>(
    call: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(call)
        .await
        .map_err(|_| Error::storage())?
}

pub(super) fn conflict_path(mut error: Error, path: String) -> Error {
    if error.status == axum::http::StatusCode::CONFLICT && error.fault.details.is_none() {
        error.fault.details = Some(Paths { paths: vec![path] });
    }
    error
}
