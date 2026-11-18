use serde::{Deserialize, Serialize};

use crate::VaultFileError;

/// Относительный POSIX-путь, который не содержит пустых сегментов или переходов вверх.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct RelativePath(String);

impl RelativePath {
    /// Разбирает путь без изменения регистра и Unicode.
    ///
    /// # Errors
    /// Возвращает `UnsafePath`, если путь не является относительным POSIX-путём.
    pub fn new(path: &str) -> Result<Self, VaultFileError> {
        Self::parse(path.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn parse(path: String) -> Result<Self, VaultFileError> {
        let drive = matches!(path.as_bytes(), [letter, b':', ..] if letter.is_ascii_alphabetic());
        if drive
            || path.contains(['\0', '\\'])
            || path.split('/').any(|part| matches!(part, "" | "." | ".."))
        {
            return Err(VaultFileError::UnsafePath { path });
        }
        Ok(Self(path))
    }

    pub(crate) fn parent(&self) -> &str {
        self.0.rsplit_once('/').map_or("", |(parent, _)| parent)
    }

    pub(crate) fn name(&self) -> &str {
        self.0.rsplit_once('/').map_or(&self.0, |(_, name)| name)
    }

    pub(crate) fn suffix_of(&self, base: &Self) -> Option<&str> {
        self.0
            .strip_prefix(&base.0)
            .filter(|suffix| suffix.is_empty() || suffix.starts_with('/'))
    }

    pub(crate) fn replace_prefix(&self, from: &Self, to: &Self) -> Result<Self, VaultFileError> {
        self.suffix_of(from).map_or_else(
            || Ok(self.clone()),
            |suffix| Self::new(&format!("{}{suffix}", to.as_str())),
        )
    }

    pub(crate) fn operational_write(&self) -> bool {
        self.0 == ".livenote/requests"
            || self.0.starts_with(".livenote/requests/")
            || self.0 == ".livenote/migration"
            || self.0.starts_with(".livenote/migration/")
    }

    pub(crate) fn author_path(&self, operational_allowed: bool) -> Result<(), VaultFileError> {
        if operational_allowed && self.operational_write() {
            return Ok(());
        }
        if self
            .0
            .split('/')
            .any(|part| part.eq_ignore_ascii_case(".git") || part.eq_ignore_ascii_case(".livenote"))
            || self
                .0
                .split('/')
                .next()
                .is_some_and(|part| part.eq_ignore_ascii_case(".livenoteignore"))
        {
            return Err(VaultFileError::invalid(&self.0));
        }
        Ok(())
    }
}

impl TryFrom<String> for RelativePath {
    type Error = VaultFileError;

    fn try_from(path: String) -> Result<Self, Self::Error> {
        Self::parse(path)
    }
}

/// Запись или удаление файла с проверкой предыдущих байтов.
#[derive(Debug)]
pub struct FileWrite<'a> {
    pub path: RelativePath,
    pub source: Option<&'a [u8]>,
    pub expected: Option<&'a [u8]>,
}

/// Переход между отсутствующим и существующим каталогом.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DirectoryChange {
    pub path: RelativePath,
    pub old: bool,
    pub next: bool,
}

/// Переименование через каталог журнала. Поддерживает смену регистра.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PathRename {
    pub from: RelativePath,
    pub to: RelativePath,
}
