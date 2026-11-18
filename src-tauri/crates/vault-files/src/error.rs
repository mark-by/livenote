use std::io;

use rustix::io::Errno;
use thiserror::Error;

/// Ошибка файлового доступа, пригодная для преобразования в ошибку приложения.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum VaultFileError {
    #[error("Небезопасный путь: {path}")]
    UnsafePath { path: String },
    #[error("Некорректный запрос: {path}")]
    InvalidRequest { path: String },
    #[error("Файл изменился во время чтения: {path}")]
    ChangedDuringRead { path: String },
    #[error("Vault уже открыт или его блокировка повреждена")]
    Locked,
    #[error("Путь изменился перед публикацией: {path}")]
    Stale { path: String },
    #[error("Транзакция {id} не завершена. Журнал сохранён: {source}")]
    TransactionIncomplete {
        id: String,
        paths: Vec<String>,
        #[source]
        source: Box<Self>,
        rollback: Option<Box<Self>>,
    },
    #[error("Повреждён журнал восстановления: {id}")]
    InvalidJournal { id: String },
    #[error("Файловая операция не выполнена: {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: io::Error,
    },
}

impl VaultFileError {
    /// Возвращает код ошибки для вызывающего приложения.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::UnsafePath { .. } => "unsafe_path",
            Self::InvalidRequest { .. } | Self::InvalidJournal { .. } => "invalid_request",
            Self::ChangedDuringRead { .. } | Self::Io { .. } => "unreadable_file",
            Self::Locked => "vault_locked",
            Self::Stale { .. } | Self::TransactionIncomplete { .. } => "conflict",
        }
    }

    pub(crate) fn unsafe_path(path: &str) -> Self {
        Self::UnsafePath { path: path.into() }
    }

    pub(crate) fn invalid(path: &str) -> Self {
        Self::InvalidRequest { path: path.into() }
    }

    pub(crate) fn stale(path: &str) -> Self {
        Self::Stale { path: path.into() }
    }

    pub(crate) fn io(path: &str, source: io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }

    pub(crate) fn errno(path: &str, source: Errno) -> Self {
        match source {
            Errno::LOOP | Errno::NOTDIR => Self::unsafe_path(path),
            _ => Self::io(path, source.into()),
        }
    }

    pub(crate) fn missing(&self) -> bool {
        matches!(self, Self::Io { source, .. } if source.kind() == io::ErrorKind::NotFound)
    }

    pub(crate) fn problem(&self, path: &str) -> VaultFileProblem {
        let code = if matches!(self, Self::UnsafePath { .. }) {
            VaultFileProblemCode::UnsafePath
        } else {
            VaultFileProblemCode::UnreadableFile
        };
        VaultFileProblem {
            path: path.into(),
            code,
            message: self.to_string(),
        }
    }
}

/// Проблема одного пути, которая не блокирует чтение остальных файлов.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultFileProblem {
    pub path: String,
    pub code: VaultFileProblemCode,
    pub message: String,
}

/// Машинный код проблемы пути.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultFileProblemCode {
    UnsafePath,
    UnreadableFile,
}

impl VaultFileProblemCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnsafePath => "unsafe_path",
            Self::UnreadableFile => "unreadable_file",
        }
    }
}
