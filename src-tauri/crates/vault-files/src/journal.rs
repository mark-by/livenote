use std::collections::BTreeSet;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use rustix::fs::{AtFlags, RenameFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::disk::Disk;
use crate::{DirectoryChange, PathRename, RelativePath, VaultFileError as Error};

pub const TRANSACTIONS: &str = ".livenote/transactions";

#[derive(Debug)]
pub struct Change {
    pub(crate) path: RelativePath,
    pub(crate) old: Option<Vec<u8>>,
    pub(crate) next: Option<Vec<u8>>,
}

#[derive(Debug)]
pub struct Journal {
    pub(crate) id: String,
    pub(crate) changes: Vec<Change>,
    pub(crate) directories: Vec<DirectoryChange>,
    pub(crate) rename: Option<PathRename>,
}

#[derive(Serialize, Deserialize)]
#[serde(transparent)]
struct Nullable(Option<String>);

// Порядок и имена полей совпадают с форматом JSON в Node.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireChange {
    path: RelativePath,
    old: Nullable,
    next: Nullable,
    old_hash: Nullable,
    new_hash: Nullable,
}

#[derive(Serialize, Deserialize)]
struct WireJournal {
    id: String,
    changes: Vec<WireChange>,
    #[serde(default)]
    directories: Vec<DirectoryChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rename: Option<PathRename>,
}

impl Journal {
    pub(crate) fn directory(&self) -> Result<RelativePath, Error> {
        RelativePath::new(&format!("{TRANSACTIONS}/{}", self.id))
    }

    pub(crate) fn entry(&self, name: &str) -> Result<RelativePath, Error> {
        RelativePath::new(&format!("{TRANSACTIONS}/{}/{name}", self.id))
    }

    pub(crate) fn paths(&self) -> impl Iterator<Item = &RelativePath> {
        self.changes
            .iter()
            .map(|change| &change.path)
            .chain(self.directories.iter().map(|change| &change.path))
            .chain(
                self.rename
                    .iter()
                    .flat_map(|rename| [&rename.from, &rename.to]),
            )
    }

    pub(crate) fn validate(&self) -> Result<(), Error> {
        let mut targets = BTreeSet::new();
        for (path, allows_operational) in self
            .changes
            .iter()
            .map(|change| (&change.path, true))
            .chain(self.directories.iter().map(|dir| (&dir.path, true)))
        {
            path.author_path(allows_operational)?;
            if !targets.insert(path) {
                return Err(Error::invalid(path.as_str()));
            }
        }
        if let Some(rename) = &self.rename {
            rename.from.author_path(false)?;
            rename.to.author_path(false)?;
            if rename.from.suffix_of(&rename.to).is_some()
                || rename.to.suffix_of(&rename.from).is_some()
            {
                return Err(Error::invalid(rename.to.as_str()));
            }
        }
        Ok(())
    }

    pub(crate) fn read(disk: &Disk, id: &str, path: &RelativePath) -> Result<Self, Error> {
        let invalid = || Error::InvalidJournal { id: id.into() };
        let file = disk.read(path).map_err(|_| invalid())?;
        let wire: WireJournal = serde_json::from_slice(&file.bytes).map_err(|_| invalid())?;
        if wire.id != id
            || (wire.changes.is_empty() && wire.directories.is_empty() && wire.rename.is_none())
        {
            return Err(invalid());
        }
        let decode = |encoded: Nullable, hash: Nullable| match (encoded.0, hash.0) {
            (None, None) => Ok(None),
            (Some(encoded), Some(hash)) => {
                let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
                if format!("{:x}", Sha256::digest(&bytes)) == hash {
                    Ok(Some(bytes))
                } else {
                    Err(invalid())
                }
            }
            (None, Some(_)) | (Some(_), None) => Err(invalid()),
        };
        let changes = wire
            .changes
            .into_iter()
            .map(|change| {
                Ok(Change {
                    path: change.path,
                    old: decode(change.old, change.old_hash)?,
                    next: decode(change.next, change.new_hash)?,
                })
            })
            .collect::<Result<_, Error>>()?;
        let journal = Self {
            id: wire.id,
            changes,
            directories: wire.directories,
            rename: wire.rename,
        };
        journal.validate().map_err(|_| invalid())?;
        Ok(journal)
    }

    pub(crate) fn persist(&self, disk: &Disk) -> Result<(), Error> {
        let direction = |bytes: Option<&[u8]>| {
            (
                Nullable(bytes.map(|bytes| STANDARD.encode(bytes))),
                Nullable(bytes.map(|bytes| format!("{:x}", Sha256::digest(bytes)))),
            )
        };
        let changes = self
            .changes
            .iter()
            .map(|change| {
                let (old, old_hash) = direction(change.old.as_deref());
                let (next, new_hash) = direction(change.next.as_deref());
                WireChange {
                    path: change.path.clone(),
                    old,
                    next,
                    old_hash,
                    new_hash,
                }
            })
            .collect();
        let wire = WireJournal {
            id: self.id.clone(),
            changes,
            directories: self.directories.clone(),
            rename: self.rename.clone(),
        };
        let path = self.directory()?;
        disk.make_parents(&path)?;
        let stage = RelativePath::new(&format!(".livenote/.prepare-{}", self.id))?;
        let json = RelativePath::new(&format!("{}/journal.json", stage.as_str()))?;
        let bytes =
            serde_json::to_vec(&wire).map_err(|error| Error::io(json.as_str(), error.into()))?;
        disk.mkdir(&stage)?;
        disk.write_exclusive(&json, &bytes)?;
        for (index, change) in self.changes.iter().enumerate() {
            if let Some(bytes) = &change.next {
                let staged = RelativePath::new(&format!("{}/new-{index}", stage.as_str()))?;
                disk.write_exclusive(&staged, bytes)?;
            }
        }
        disk.rename(&stage, &path, RenameFlags::NOREPLACE)
    }

    pub(crate) fn retire(&self, disk: &Disk) -> Result<(), Error> {
        let source = self.directory()?;
        let retired = RelativePath::new(&format!(".livenote/.finished-{}", Uuid::new_v4()))?;
        disk.rename(&source, &retired, RenameFlags::NOREPLACE)?;
        for entry in disk.entries(retired.as_str())? {
            let entry = entry.map_err(|error| Error::errno(retired.as_str(), error))?;
            let Ok(name) = entry.file_name().to_str() else {
                continue;
            };
            // Удаляем только артефакты журнала. Неизвестные записи сохраняем.
            if name == "journal.json"
                || name.starts_with("new-")
                || name.starts_with("recover-")
                || name.starts_with("undo-")
            {
                let artifact = RelativePath::new(&format!("{}/{name}", retired.as_str()))?;
                let stat = disk.stat(&artifact)?;
                if stat.is_some_and(|stat| {
                    crate::disk::file_type(&stat) == rustix::fs::FileType::RegularFile
                }) {
                    disk.unlink(&artifact, AtFlags::empty())?;
                }
            }
        }
        match disk.unlink(&retired, AtFlags::REMOVEDIR) {
            Err(Error::Io { source, .. })
                if source.kind() == std::io::ErrorKind::DirectoryNotEmpty =>
            {
                Ok(())
            }
            result => result,
        }
    }
}
