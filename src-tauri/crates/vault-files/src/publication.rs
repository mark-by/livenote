mod rollback;
#[cfg(test)]
mod tests;

use rustix::fs::{AtFlags, FileType, RenameFlags};
use uuid::Uuid;

use crate::disk::{Disk, file_type};
use crate::journal::{Change, Journal};
use crate::plan::exact_exists;
use crate::{RelativePath, VaultFileError as Error};
use rollback::Undo;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Commit,
    Recover,
}

pub struct Publication<'a> {
    disk: &'a Disk,
    journal: &'a Journal,
    undo: Vec<Undo<'a>>,
}

impl<'a> Publication<'a> {
    pub(crate) const fn new(disk: &'a Disk, journal: &'a Journal) -> Self {
        Self {
            disk,
            journal,
            undo: Vec::new(),
        }
    }

    fn rename_location(&self) -> Result<Option<RelativePath>, Error> {
        let Some(rename) = &self.journal.rename else {
            return Ok(None);
        };
        let staged = self.journal.entry("renamed")?;
        let from = exact_exists(self.disk, &rename.from)?;
        let to = exact_exists(self.disk, &rename.to)?;
        let staged_exists = self.disk.stat(&staged)?.is_some();
        let location = match (from, to, staged_exists) {
            (true, false, false) => rename.from.clone(),
            (false, true, false) => rename.to.clone(),
            (false, false, true) => staged,
            _ => return Err(Error::stale(rename.to.as_str())),
        };
        let kind = self.disk.stat(&location)?.map(|stat| file_type(&stat));
        if !matches!(kind, Some(FileType::Directory | FileType::RegularFile)) {
            return Err(Error::unsafe_path(location.as_str()));
        }
        Ok(Some(location))
    }

    fn current_path(
        &self,
        location: Option<&RelativePath>,
        path: &RelativePath,
    ) -> Result<RelativePath, Error> {
        match (self.journal.rename.as_ref(), location) {
            (Some(rename), Some(location)) => path.replace_prefix(&rename.to, location),
            (Some(_), None) | (None, _) => Ok(path.clone()),
        }
    }

    pub(crate) fn apply(&mut self, mode: Mode) -> Result<(), Error> {
        let location = self.rename_location()?;
        if mode == Mode::Commit
            && self
                .journal
                .rename
                .as_ref()
                .is_some_and(|rename| location.as_ref() != Some(&rename.from))
        {
            return Err(Error::stale(
                location.as_ref().map_or("", RelativePath::as_str),
            ));
        }
        for change in &self.journal.changes {
            let path = self.current_path(location.as_ref(), &change.path)?;
            let actual = self.disk.read_optional(&path)?.map(|file| file.bytes);
            if actual != change.old && (mode == Mode::Commit || actual != change.next) {
                return Err(Error::stale(path.as_str()));
            }
        }
        for directory in &self.journal.directories {
            let path = self.current_path(location.as_ref(), &directory.path)?;
            let stat = self.disk.stat(&path)?;
            let exists = stat.is_some();
            if stat.is_some_and(|stat| file_type(&stat) != FileType::Directory)
                || (exists != directory.old && (mode == Mode::Commit || exists != directory.next))
            {
                return Err(Error::stale(path.as_str()));
            }
            if exists && !directory.next {
                self.check_removal(&path, &directory.path)?;
            }
        }
        let mut create: Vec<_> = self
            .journal
            .directories
            .iter()
            .filter(|entry| entry.next)
            .collect();
        create.sort_by_key(|entry| entry.path.as_str().len());
        for entry in &create {
            let before_rename = self
                .journal
                .rename
                .as_ref()
                .is_some_and(|rename| entry.path.suffix_of(&rename.to).is_none());
            if before_rename {
                self.create_directory(&entry.path, mode, entry.old)?;
            }
        }
        if let (Some(rename), Some(location)) = (&self.journal.rename, location)
            && location != rename.to
        {
            let staged = self.journal.entry("renamed")?;
            if location == rename.from {
                let stat = self
                    .disk
                    .stat(&location)?
                    .ok_or_else(|| Error::stale(location.as_str()))?;
                // При ошибке fsync переименование уже могло произойти.
                self.undo.push(Undo::Rename(rename, stat));
                self.disk
                    .rename(&rename.from, &staged, RenameFlags::NOREPLACE)?;
            }
            self.disk.make_parents(&rename.to)?;
            self.disk
                .rename(&staged, &rename.to, RenameFlags::NOREPLACE)?;
        }
        for entry in create {
            let after_rename = self
                .journal
                .rename
                .as_ref()
                .is_none_or(|rename| entry.path.suffix_of(&rename.to).is_some());
            if after_rename {
                self.create_directory(&entry.path, mode, entry.old)?;
            }
        }
        for (index, change) in self.journal.changes.iter().enumerate() {
            self.publish_file(index, change, mode)?;
        }
        let mut remove: Vec<_> = self
            .journal
            .directories
            .iter()
            .filter(|entry| !entry.next)
            .collect();
        remove.sort_by_key(|entry| std::cmp::Reverse(entry.path.as_str().len()));
        for entry in remove {
            match self.disk.unlink(&entry.path, AtFlags::REMOVEDIR) {
                Ok(()) => self.undo.push(Undo::Removed(&entry.path)),
                Err(error) if mode == Mode::Recover && error.missing() => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn check_removal(&self, path: &RelativePath, target: &RelativePath) -> Result<(), Error> {
        for entry in self.disk.entries(path.as_str())? {
            let entry = entry.map_err(|error| Error::errno(path.as_str(), error))?;
            let name = entry.file_name();
            if matches!(name.to_bytes(), b"." | b"..") {
                continue;
            }
            let name = name.to_str().map_err(|_| Error::stale(path.as_str()))?;
            let child = RelativePath::new(&format!("{}/{name}", target.as_str()))?;
            let known = self
                .journal
                .changes
                .iter()
                .any(|entry| entry.path == child && entry.next.is_none())
                || self
                    .journal
                    .directories
                    .iter()
                    .any(|entry| entry.path == child && !entry.next);
            if !known {
                return Err(Error::stale(child.as_str()));
            }
        }
        Ok(())
    }

    fn create_directory(
        &mut self,
        path: &'a RelativePath,
        mode: Mode,
        old: bool,
    ) -> Result<(), Error> {
        if old || mode == Mode::Recover {
            if let Some(stat) = self.disk.stat(path)? {
                if file_type(&stat) == FileType::Directory {
                    return Ok(());
                }
                return Err(Error::stale(path.as_str()));
            }
            if old && mode == Mode::Commit {
                return Err(Error::stale(path.as_str()));
            }
        }
        self.disk.make_parents(path)?;
        self.disk.mkdir(path)?;
        let stat = self
            .disk
            .stat(path)?
            .ok_or_else(|| Error::stale(path.as_str()))?;
        self.undo.push(Undo::Created(path, stat));
        Ok(())
    }

    fn publish_file(&mut self, index: usize, change: &'a Change, mode: Mode) -> Result<(), Error> {
        let path = &change.path;
        let actual = self.disk.read_optional(path)?.map(|file| file.bytes);
        if mode == Mode::Recover && actual == change.next {
            return Ok(());
        }
        if actual != change.old {
            return Err(Error::stale(path.as_str()));
        }
        if let Some(bytes) = &change.next {
            let staged = match mode {
                Mode::Commit => {
                    let staged = self.journal.entry(&format!("new-{index}"))?;
                    if self.disk.read(&staged)?.bytes != *bytes {
                        return Err(Error::stale(staged.as_str()));
                    }
                    staged
                }
                Mode::Recover => {
                    let staged = self
                        .journal
                        .entry(&format!("recover-{index}-{}", Uuid::new_v4()))?;
                    self.disk.write_exclusive(&staged, bytes)?;
                    staged
                }
            };
            self.disk.make_parents(path)?;
            if self.disk.read_optional(path)?.map(|file| file.bytes) != change.old {
                return Err(Error::stale(path.as_str()));
            }
            self.disk.rename(
                &staged,
                path,
                if actual.is_none() {
                    RenameFlags::NOREPLACE
                } else {
                    RenameFlags::empty()
                },
            )?;
        } else {
            self.disk.unlink(path, AtFlags::empty())?;
        }
        self.undo.push(Undo::File(change));
        Ok(())
    }
}
