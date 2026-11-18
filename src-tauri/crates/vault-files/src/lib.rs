//! Файловый доступ к хранилищу `LiveNote` на macOS и Linux.

mod disk;
mod error;
mod journal;
mod listing;
mod lock;
mod path;
mod plan;
mod publication;
mod transaction;

use std::path::Path;
use std::time::SystemTime;

pub use error::{VaultFileError, VaultFileProblem, VaultFileProblemCode};
pub use listing::VaultListing;
pub use path::{DirectoryChange, FileWrite, PathRename, RelativePath};

use disk::Disk;
use lock::WriterLock;

/// Обычный файл без преобразования содержимого.
#[derive(Debug)]
pub struct VaultFile {
    pub bytes: Vec<u8>,
    pub modified: SystemTime,
    pub created: Option<SystemTime>,
    /// Метка `dev:ino:size:mtimeNs:ctimeNs:birthtimeNs`, совместимая с Node.
    pub stamp: String,
}

/// Хранилище с блокировкой записи до освобождения объекта.
#[derive(Debug)]
pub struct VaultFiles {
    disk: Disk,
    recovery_problems: Vec<VaultFileProblem>,
    _lock: WriterLock,
    quarantined: Vec<RelativePath>,
}

impl VaultFiles {
    /// Открывает или создаёт каталог и восстанавливает известные транзакции.
    ///
    /// # Errors
    /// Возвращает ошибку пути, блокировки, журнала или ввода-вывода.
    pub fn open(root: &Path) -> Result<Self, VaultFileError> {
        let disk = Disk::open(root)?;
        let lock = WriterLock::acquire(&disk)?;
        let mut vault = Self {
            disk,
            recovery_problems: Vec::new(),
            _lock: lock,
            quarantined: Vec::new(),
        };
        vault.recover()?;
        let ignore = RelativePath::new(".livenote/.gitignore")?;
        if vault.disk.read_optional(&ignore)?.is_none() {
            vault.disk.write_exclusive(&ignore, b"*\n")?;
        }
        Ok(vault)
    }

    /// Возвращает канонический путь к корню хранилища.
    #[must_use]
    pub fn root(&self) -> &Path {
        self.disk.root()
    }

    /// Возвращает проблемы транзакций, которые требуют ручного восстановления.
    #[must_use]
    pub fn recovery_problems(&self) -> &[VaultFileProblem] {
        &self.recovery_problems
    }

    /// Читает байты обычного файла, включая скрытый файл вложения.
    ///
    /// # Errors
    /// Возвращает ошибку, если путь недоступен, небезопасен или изменился при чтении.
    pub fn read(&self, path: &str) -> Result<VaultFile, VaultFileError> {
        self.disk.check_root()?;
        self.disk.read(&RelativePath::new(path)?)
    }

    /// Возвращает метку обычного файла без чтения его содержимого.
    ///
    /// # Errors
    /// Возвращает ошибку, если путь недоступен или указывает не на обычный файл.
    pub fn stamp(&self, path: &str) -> Result<String, VaultFileError> {
        self.disk.check_root()?;
        Ok(self.disk.stamp(&RelativePath::new(path)?)?.to_string())
    }

    /// Читает обычный файл. Отсутствующий файл возвращает `None`.
    ///
    /// # Errors
    /// Возвращает любую ошибку чтения, кроме отсутствия файла.
    pub fn read_optional(&self, path: &str) -> Result<Option<VaultFile>, VaultFileError> {
        self.disk.check_root()?;
        self.disk.read_optional(&RelativePath::new(path)?)
    }
}
