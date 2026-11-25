use std::io::ErrorKind;

use rustix::fs::{AtFlags, FileType, RenameFlags, fsync};
use uuid::Uuid;

use crate::disk::{Disk, file_type};
use crate::{RelativePath, VaultFileError as Error};

use super::{Journal, TRANSACTIONS};

const METADATA: &str = ".livenote";
const PREFIX: &str = ".finished-";

pub(crate) struct FinishedJournal(RelativePath);

impl Journal {
    pub(crate) fn confirm(&self, disk: &Disk) -> Result<FinishedJournal, Error> {
        let source = self.directory()?;
        let finished = RelativePath::new(&format!("{METADATA}/{PREFIX}{}", Uuid::new_v4()))?;
        disk.rename(&source, &finished, RenameFlags::NOREPLACE)?
            .sync()?;
        Ok(FinishedJournal(finished))
    }
}

impl FinishedJournal {
    pub(crate) fn retry_all(disk: &Disk) -> Result<(), Error> {
        let mut finished = Vec::new();
        for entry in disk.entries(METADATA)? {
            let entry = entry.map_err(|error| Error::errno(METADATA, error))?;
            if let Ok(name) = entry.file_name().to_str()
                && let Some(id) = name.strip_prefix(PREFIX)
                && Uuid::parse_str(id).is_ok_and(|uuid| uuid.hyphenated().to_string() == id)
            {
                let path = RelativePath::new(&format!("{METADATA}/{name}"))?;
                finished.push(Self(path));
            }
        }
        if finished.is_empty() {
            return Ok(());
        }
        // Имя .finished-* может остаться после успешного renameat и ошибки fsync.
        // Подтверждаем оба каталога до удаления журнала.
        fsync(disk.dir(METADATA)?).map_err(|error| Error::errno(METADATA, error))?;
        match disk.dir(TRANSACTIONS) {
            Ok(active) => {
                fsync(active).map_err(|error| Error::errno(TRANSACTIONS, error))?;
            }
            Err(error) if error.missing() => {}
            Err(error) => return Err(error),
        }
        for journal in finished {
            journal.cleanup(disk);
        }
        Ok(())
    }

    pub(crate) fn cleanup(&self, disk: &Disk) {
        if let Err(error) = remove_artifacts(disk, &self.0) {
            eprintln!("Не удалось убрать артефакты завершённой транзакции: {error}");
        }
    }
}

pub(super) fn remove_artifacts(disk: &Disk, directory: &RelativePath) -> Result<(), Error> {
    let path = directory.as_str();
    for entry in disk.entries(path)? {
        let entry = entry.map_err(|error| Error::errno(path, error))?;
        let Ok(name) = entry.file_name().to_str() else {
            continue;
        };
        // Неизвестные записи сохраняем.
        if name == "journal.json"
            || name.starts_with("new-")
            || name.starts_with("recover-")
            || name.starts_with("undo-")
        {
            let artifact = RelativePath::new(&format!("{path}/{name}"))?;
            if disk
                .stat(&artifact)?
                .is_some_and(|stat| file_type(&stat) == FileType::RegularFile)
            {
                disk.unlink(&artifact, AtFlags::empty())?.sync()?;
            }
        }
    }
    match disk.unlink(directory, AtFlags::REMOVEDIR) {
        Ok(applied) => applied.sync(),
        Err(Error::Io { source, .. }) if source.kind() == ErrorKind::DirectoryNotEmpty => Ok(()),
        Err(error) => Err(error),
    }
}
