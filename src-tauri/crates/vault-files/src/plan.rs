use std::collections::{BTreeMap, BTreeSet};

use rustix::fs::FileType;
use uuid::Uuid;

use crate::disk::{Disk, file_type};
use crate::journal::{Change, Journal};
use crate::listing::IgnoreRules;
use crate::{
    DirectoryChange, FileWrite, PathRename, RelativePath, VaultFileError as Error, VaultFiles,
};

fn from_path(rename: Option<&PathRename>, path: &RelativePath) -> Result<RelativePath, Error> {
    rename.map_or_else(
        || Ok(path.clone()),
        |rename| path.replace_prefix(&rename.to, &rename.from),
    )
}

pub fn exact_exists(disk: &Disk, path: &RelativePath) -> Result<bool, Error> {
    let entries = match disk.entries(path.parent()) {
        Ok(entries) => entries,
        Err(error) if error.missing() => return Ok(false),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry.map_err(|error| Error::errno(path.as_str(), error))?;
        if entry.file_name().to_bytes() == path.name().as_bytes() {
            return Ok(true);
        }
    }
    Ok(false)
}

impl VaultFiles {
    pub(crate) fn plan(
        &self,
        writes: &[FileWrite<'_>],
        directories: &[DirectoryChange],
        rename: Option<&PathRename>,
    ) -> Result<Journal, Error> {
        let visible_targets = writes.iter().any(|write| !write.path.operational_write())
            || directories.iter().any(|dir| !dir.path.operational_write())
            || rename.is_some();
        let rules = if visible_targets {
            IgnoreRules::read(&self.disk)?
        } else {
            IgnoreRules::default()
        };
        let validate = |path: &RelativePath, directory: bool| {
            path.author_path(true)?;
            if !path.operational_write() {
                rules.assert_visible(&self.disk, path, directory)?;
            }
            Ok::<(), Error>(())
        };
        if let Some(rename) = rename {
            self.validate_rename(rename, &rules)?;
        }
        let mut dirs = BTreeMap::new();
        let mut order = Vec::new();
        for entry in directories {
            validate(&entry.path, true)?;
            self.reject_quarantined([&entry.path])?;
            if dirs.insert(entry.path.clone(), entry.clone()).is_some() {
                return Err(Error::invalid(entry.path.as_str()));
            }
            order.push(entry.path.clone());
        }
        let mut changes = Vec::new();
        let mut writes_seen = BTreeSet::new();
        for write in writes {
            validate(&write.path, false)?;
            self.reject_quarantined([&write.path])?;
            if !writes_seen.insert(&write.path) || dirs.contains_key(&write.path) {
                return Err(Error::invalid(write.path.as_str()));
            }
            changes.extend(self.plan_change(write, rename)?);
        }
        let parents = writes
            .iter()
            .filter(|write| write.source.is_some())
            .map(|write| write.path.parent())
            .chain(
                directories
                    .iter()
                    .filter(|directory| directory.next)
                    .map(|dir| dir.path.parent()),
            )
            .chain(rename.iter().map(|rename| rename.to.parent()));
        for parent in parents {
            let prefixes = parent
                .match_indices('/')
                .map(|(index, _)| &parent[..index])
                .chain(std::iter::once(parent))
                .filter(|prefix| !prefix.is_empty());
            for prefix in prefixes {
                let path = RelativePath::new(prefix)?;
                if let Some(dir) = dirs.get(&path) {
                    if !dir.next {
                        return Err(Error::invalid(path.as_str()));
                    }
                    continue;
                }
                let original = from_path(rename, &path)?;
                match self.disk.stat(&original)? {
                    Some(stat) if file_type(&stat) == FileType::Directory => {}
                    Some(_) => return Err(Error::unsafe_path(path.as_str())),
                    None => {
                        validate(&path, true)?;
                        order.push(path.clone());
                        dirs.insert(
                            path.clone(),
                            DirectoryChange {
                                path,
                                old: false,
                                next: true,
                            },
                        );
                    }
                }
            }
        }
        let directories: Vec<_> = order.iter().filter_map(|path| dirs.remove(path)).collect();
        let journal = Journal {
            id: Uuid::new_v4().to_string(),
            changes,
            directories,
            rename: rename.cloned(),
            preserve_staged: false,
        };
        journal.validate()?;
        self.validate_directories(&journal)?;
        Ok(journal)
    }

    fn plan_change(
        &self,
        write: &FileWrite<'_>,
        rename: Option<&PathRename>,
    ) -> Result<Option<Change>, Error> {
        let path = from_path(rename, &write.path)?;
        let actual = self.disk.read_optional(&path)?.map(|file| file.bytes);
        if actual.as_deref() != write.expected {
            return Err(Error::stale(write.path.as_str()));
        }
        Ok((actual.as_deref() != write.source).then(|| Change {
            path: write.path.clone(),
            old: actual,
            next: write.source.map(<[u8]>::to_vec),
        }))
    }

    fn validate_directories(&self, journal: &Journal) -> Result<(), Error> {
        for entry in &journal.directories {
            let path = from_path(journal.rename.as_ref(), &entry.path)?;
            let actual = self.disk.stat(&path)?;
            if actual.is_some() != entry.old
                || actual.is_some_and(|stat| file_type(&stat) != FileType::Directory)
            {
                return Err(Error::stale(entry.path.as_str()));
            }
            if !entry.next && !entry.path.operational_write() {
                let scan = self.list_in(path.as_str(), false)?;
                if !scan.hidden_entries.is_empty() || !scan.problems.is_empty() {
                    return Err(Error::invalid(entry.path.as_str()));
                }
            }
        }
        Ok(())
    }

    fn validate_rename(&self, rename: &PathRename, rules: &IgnoreRules) -> Result<(), Error> {
        rename.from.author_path(false)?;
        rename.to.author_path(false)?;
        if rename.from.suffix_of(&rename.to).is_some()
            || rename.to.suffix_of(&rename.from).is_some()
        {
            return Err(Error::invalid(rename.to.as_str()));
        }
        self.reject_quarantined([&rename.from, &rename.to])?;
        if !exact_exists(&self.disk, &rename.from)? || exact_exists(&self.disk, &rename.to)? {
            return Err(Error::stale(rename.to.as_str()));
        }
        let kind = self.disk.stat(&rename.from)?.map(|stat| file_type(&stat));
        let directory = match kind {
            Some(FileType::Directory) => true,
            Some(FileType::RegularFile) => false,
            _ => return Err(Error::unsafe_path(rename.from.as_str())),
        };
        rules.assert_visible(&self.disk, &rename.from, directory)?;
        rules.assert_visible(&self.disk, &rename.to, directory)?;
        if directory {
            let scan = self.list_in(rename.from.as_str(), false)?;
            if !scan.hidden_entries.is_empty() || !scan.problems.is_empty() {
                return Err(Error::invalid(rename.from.as_str()));
            }
            for path in scan.folders {
                let original = RelativePath::new(&path)?;
                if let Some(suffix) = original.suffix_of(&rename.from) {
                    let destination =
                        RelativePath::new(&format!("{}{suffix}", rename.to.as_str()))?;
                    destination.author_path(false)?;
                    rules.assert_visible(&self.disk, &destination, true)?;
                }
            }
        }
        Ok(())
    }
}
