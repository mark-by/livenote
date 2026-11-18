use std::{collections::HashMap, sync::Arc, time::SystemTime};

use serde::{Deserialize, Serialize};

use crate::{
    AssetRead, FileTimes, ProblemCode, VaultProblem, file_version,
    markdown::{self, Syntax},
    openable,
};

/// Проверенные байты и штамп из одного чтения.
#[derive(Debug)]
pub struct FileBytes {
    pub bytes: Vec<u8>,
    pub stamp: String,
    pub times: FileTimes,
}

/// Диагностика операции чтения, которую назначил файловый слой.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct FileFailure {
    pub code: ProblemCode,
    pub message: String,
}

/// Адаптер проверенного чтения. Реализация владеет правилами доступа к Vault.
pub trait VaultReadSource {
    /// Возвращает штамп, который меняется при любой замене или изменении файла.
    ///
    /// # Errors
    /// Возвращает диагностику недоступного файла.
    fn stamp(&self, path: &str) -> Result<String, FileFailure>;
    /// Возвращает байты и штамп одной подтверждённой версии файла.
    ///
    /// # Errors
    /// Возвращает диагностику недоступного или изменившегося при чтении файла.
    fn read_bytes(&self, path: &str) -> Result<FileBytes, FileFailure>;
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FileRecord {
    pub(crate) stamp: String,
    pub(crate) version: String,
    created: Option<jiff::Timestamp>,
    modified: jiff::Timestamp,
    pub(crate) text: FileText,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum FileText {
    Binary,
    Invalid { problem: VaultProblem },
    Conflict { source: String },
    Document { source: String, syntax: Arc<Syntax> },
}

pub(crate) type Records = HashMap<String, Arc<FileRecord>>;

impl FileRecord {
    pub(crate) fn parse(path: &str, file: FileBytes) -> Self {
        let version = file_version(&file.bytes);
        let text = if openable(path) {
            match String::from_utf8(file.bytes) {
                Ok(source) => match markdown::parse(&source, path) {
                    Ok(syntax) => FileText::Document {
                        source,
                        syntax: Arc::new(syntax),
                    },
                    Err(error) if error.code == ProblemCode::GitConflict => {
                        FileText::Conflict { source }
                    }
                    Err(problem) => FileText::Invalid { problem },
                },
                Err(_) => FileText::Invalid {
                    problem: VaultProblem::document(
                        ProblemCode::UnreadableFile,
                        path,
                        "Файл не является UTF-8",
                    ),
                },
            }
        } else {
            FileText::Binary
        };
        Self {
            stamp: file.stamp,
            version,
            text,
            created: file
                .times
                .created
                .and_then(|time| jiff::Timestamp::try_from(time).ok()),
            modified: jiff::Timestamp::try_from(file.times.modified)
                .unwrap_or(jiff::Timestamp::UNIX_EPOCH),
        }
    }

    pub(crate) fn times(&self) -> FileTimes {
        FileTimes {
            created: self.created.map(SystemTime::from),
            modified: SystemTime::from(self.modified),
        }
    }

    pub(crate) fn asset(&self) -> Result<AssetRead, ProblemCode> {
        match &self.text {
            FileText::Document { source, .. } | FileText::Conflict { source } => Ok(AssetRead {
                source: source.clone(),
                modified: self.times().modified,
                version: Some(self.version.clone()),
            }),
            FileText::Binary | FileText::Invalid { .. } => Err(ProblemCode::UnreadableFile),
        }
    }
}
