use rustix::fs::{AtFlags, RenameFlags, Stat};
use uuid::Uuid;

use crate::disk::{Applied, same_inode};
use crate::journal::Change;
use crate::{PathRename, RelativePath, VaultFileError as Error};

use super::Publication;

pub(super) enum Undo<'a> {
    File(&'a Change),
    Created(&'a RelativePath, Stat),
    Removed(&'a RelativePath),
    Rename(&'a PathRename, Stat),
}

impl Publication<'_> {
    pub(crate) fn rollback(self) -> Result<(), Error> {
        let mut failure = None;
        for action in self.undo.iter().rev() {
            let result = match action {
                Undo::File(change) => self.undo_file(change),
                Undo::Removed(path) => self.disk.mkdir(path).and_then(Applied::sync),
                Undo::Created(path, original) => self.disk.stat(path).and_then(|stat| {
                    if stat.is_some_and(|stat| same_inode(&stat, original)) {
                        self.disk.unlink(path, AtFlags::REMOVEDIR)?.sync()
                    } else {
                        Err(Error::stale(path.as_str()))
                    }
                }),
                Undo::Rename(rename, original) if failure.is_none() => {
                    self.undo_rename(rename, original)
                }
                Undo::Rename(_, _) => continue,
            };
            if let Err(error) = result {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    fn undo_rename(&self, rename: &PathRename, original: &Stat) -> Result<(), Error> {
        let location = self
            .rename_location()?
            .ok_or_else(|| Error::stale(rename.to.as_str()))?;
        if location == rename.from {
            return Ok(());
        }
        if !self
            .disk
            .stat(&location)?
            .is_some_and(|stat| same_inode(&stat, original))
        {
            // Восстановление содержимого обычного файла создаёт новый inode.
            let change = self.undo.iter().find_map(|action| match action {
                Undo::File(change) if change.path == location => Some(*change),
                Undo::File(_) | Undo::Created(_, _) | Undo::Removed(_) | Undo::Rename(_, _) => None,
            });
            let Some(bytes) = change.and_then(|change| change.old.as_deref()) else {
                return Err(Error::stale(location.as_str()));
            };
            if self.disk.read(&location)?.bytes != bytes {
                return Err(Error::stale(location.as_str()));
            }
        }
        // На ФС без учёта регистра сначала освобождаем имя назначения.
        let staged = self.journal.entry("renamed")?;
        if location == rename.to {
            self.disk
                .rename(&location, &staged, RenameFlags::NOREPLACE)?
                .sync()?;
        }
        self.disk
            .rename(&staged, &rename.from, RenameFlags::NOREPLACE)?
            .sync()
    }

    fn undo_file(&self, change: &Change) -> Result<(), Error> {
        let path = &change.path;
        if self.disk.read_optional(path)?.map(|file| file.bytes) != change.next {
            return Err(Error::stale(path.as_str()));
        }
        if let Some(bytes) = &change.old {
            let staged = self.journal.entry(&format!("undo-{}", Uuid::new_v4()))?;
            self.disk.write_exclusive(&staged, bytes)?;
            if self.disk.read_optional(path)?.map(|file| file.bytes) != change.next {
                return Err(Error::stale(path.as_str()));
            }
            let flags = if change.next.is_none() {
                RenameFlags::NOREPLACE
            } else {
                RenameFlags::empty()
            };
            self.disk.rename(&staged, path, flags)?.sync()
        } else {
            self.disk.unlink(path, AtFlags::empty())?.sync()
        }
    }
}
