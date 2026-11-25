use std::time::SystemTime;

use rustix::fs::RenameFlags;

use super::{Journal, finished::remove_artifacts};
use crate::{RelativePath, VaultFileError as Error, disk::Disk};

/// Время создания и изменения файла, который опубликует журнал.
#[derive(Debug, Clone, Copy)]
pub struct StagedTimes<'a> {
    pub path: &'a RelativePath,
    pub created: Option<SystemTime>,
    pub modified: SystemTime,
}

pub(crate) struct Stage<'a> {
    disk: &'a Disk,
    directory: RelativePath,
    active: bool,
}

impl Journal {
    pub(crate) fn stage<'a>(&self, disk: &'a Disk) -> Result<Stage<'a>, Error> {
        disk.make_parents(&self.directory()?)?;
        let directory = RelativePath::new(&format!(".livenote/.prepare-{}", self.id))?;
        let applied = disk.mkdir(&directory)?;
        let sync = applied.sync();
        let stage = Stage {
            disk,
            directory,
            active: false,
        };
        sync?;
        stage.write_changes(self, 0)?;
        Ok(stage)
    }
}

impl Stage<'_> {
    fn entry(&self, name: &str) -> Result<RelativePath, Error> {
        RelativePath::new(&format!("{}/{name}", self.directory.as_str()))
    }

    pub(crate) fn write_changes(&self, journal: &Journal, start: usize) -> Result<(), Error> {
        for (index, change) in journal.changes.iter().enumerate().skip(start) {
            if let Some(bytes) = &change.next {
                let path = self.entry(&format!("new-{index}"))?;
                self.disk.write_exclusive(&path, bytes)?;
            }
        }
        Ok(())
    }

    pub(crate) fn times<'a>(&self, journal: &'a Journal) -> Result<Vec<StagedTimes<'a>>, Error> {
        journal
            .changes
            .iter()
            .enumerate()
            .filter(|(_, change)| change.next.is_some())
            .map(|(index, change)| {
                let staged = self.entry(&format!("new-{index}"))?;
                let file = self.disk.read(&staged)?;
                Ok(StagedTimes {
                    path: &change.path,
                    created: file.created,
                    modified: file.modified,
                })
            })
            .collect()
    }

    pub(crate) fn activate(mut self, journal: &Journal) -> Result<(), Error> {
        let json = self.entry("journal.json")?;
        self.disk.write_exclusive(&json, &journal.encode(&json)?)?;
        let destination = journal.directory()?;
        let applied = self
            .disk
            .rename(&self.directory, &destination, RenameFlags::NOREPLACE)?;
        // После rename сбой fsync не даёт права удалять активный журнал.
        self.active = true;
        applied.sync()
    }
}

impl Drop for Stage<'_> {
    fn drop(&mut self) {
        if !self.active
            && let Err(error) = remove_artifacts(self.disk, &self.directory)
        {
            eprintln!("Не удалось удалить подготовленные файлы транзакции: {error}");
        }
    }
}
