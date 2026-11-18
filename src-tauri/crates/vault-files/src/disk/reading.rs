use std::fs::File;
use std::io::Read;

use rustix::fs::{Mode, OFlags, openat};

use super::{Disk, stamp::FileStamp};
use crate::{RelativePath, VaultFile, VaultFileError as Error};

impl Disk {
    pub(crate) fn stamp(&self, path: &RelativePath) -> Result<FileStamp, Error> {
        let parent = self.dir(path.parent())?;
        FileStamp::named(&parent, path)
    }

    pub(crate) fn read(&self, path: &RelativePath) -> Result<VaultFile, Error> {
        let label = path.as_str();
        let parent = self.dir(path.parent())?;
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
        let fd = openat(&parent, path.name(), flags, Mode::empty())
            .map_err(|source| Error::errno(label, source))?;
        let before = FileStamp::opened(&fd, path)?;
        let mut file = File::from(fd);
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|source| Error::io(label, source))?;
        let metadata = file.metadata().map_err(|source| Error::io(label, source))?;
        let after = FileStamp::opened(&file, path)?;
        if before != after || before != self.stamp(path)? {
            return Err(Error::ChangedDuringRead { path: label.into() });
        }
        let modified = metadata
            .modified()
            .map_err(|source| Error::io(label, source))?;
        let created = match metadata.created() {
            Ok(created) => Some(created),
            Err(source) if source.kind() == std::io::ErrorKind::Unsupported => None,
            Err(source) => return Err(Error::io(label, source)),
        };
        Ok(VaultFile {
            bytes,
            modified,
            created,
            stamp: after.to_string(),
        })
    }

    pub(crate) fn read_optional(&self, path: &RelativePath) -> Result<Option<VaultFile>, Error> {
        match self.read(path) {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.missing() => Ok(None),
            Err(error) => Err(error),
        }
    }
}
