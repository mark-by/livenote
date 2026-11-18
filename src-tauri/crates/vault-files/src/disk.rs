mod reading;
mod stamp;

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Write;
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Component, Path, PathBuf};

use rustix::fs::{
    AtFlags, Dir, FileType, Mode, OFlags, RenameFlags, Stat, fstat, fsync, mkdirat, open, openat,
    renameat, renameat_with, statat, unlinkat,
};
use rustix::io::Errno;

use crate::{RelativePath, VaultFileError as Error};

const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
const DIRECTORY_MODE: Mode = Mode::from_bits_truncate(0o777);
const FILE_MODE: Mode = Mode::from_bits_truncate(0o600);

#[derive(Debug)]
pub struct Disk {
    root: PathBuf,
    fd: OwnedFd,
}

fn directory_at(fd: impl AsFd, name: &OsStr, label: &str) -> Result<OwnedFd, Error> {
    openat(fd, name, DIRECTORY, Mode::empty()).map_err(|source| Error::errno(label, source))
}

fn absolute_dir(path: &Path) -> Result<OwnedFd, Error> {
    let label = path.to_string_lossy();
    let mut fd =
        open("/", DIRECTORY, Mode::empty()).map_err(|source| Error::errno(&label, source))?;
    for component in path.components() {
        if let Component::Normal(name) = component {
            fd = directory_at(&fd, name, &label)?;
        }
    }
    Ok(fd)
}

pub const fn file_type(stat: &Stat) -> FileType {
    FileType::from_raw_mode(stat.st_mode)
}

pub fn same_inode(left: &Stat, right: &Stat) -> bool {
    (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)
}

impl Disk {
    pub(crate) fn open(requested: &Path) -> Result<Self, Error> {
        if requested.as_os_str().is_empty() {
            return Err(Error::unsafe_path(""));
        }
        let label = requested.to_string_lossy();
        let absolute =
            std::path::absolute(requested).map_err(|source| Error::io(&label, source))?;
        let mut normalized = PathBuf::from("/");
        for part in absolute.components() {
            match part {
                Component::ParentDir => {
                    normalized.pop();
                }
                Component::Normal(name) => normalized.push(name),
                Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
            }
        }
        let requested = normalized.as_path();
        // Путь к корню может проходить через системную ссылку, например /tmp.
        if let Some(name) = requested.file_name() {
            let parent = requested
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            fs::create_dir_all(parent).map_err(|source| Error::io(&label, source))?;
            let parent = parent
                .canonicalize()
                .map_err(|source| Error::io(&label, source))?;
            let base = absolute_dir(&parent)?;
            match mkdirat(&base, name, DIRECTORY_MODE) {
                Ok(()) => fsync(&base).map_err(|source| Error::errno(&label, source))?,
                Err(Errno::EXIST) => {}
                Err(source) => return Err(Error::errno(&label, source)),
            }
            let fd = directory_at(&base, name, &label)?;
            let root = parent
                .join(name)
                .canonicalize()
                .map_err(|source| Error::io(&label, source))?;
            let disk = Self { root, fd };
            disk.check_root()?;
            return Ok(disk);
        }
        let root = requested
            .canonicalize()
            .map_err(|source| Error::io(&label, source))?;
        let fd = absolute_dir(&root)?;
        Ok(Self { root, fd })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn check_root(&self) -> Result<(), Error> {
        let label = self.root.to_string_lossy();
        let current = absolute_dir(&self.root)?;
        let stat = |fd| fstat(fd).map_err(|source| Error::errno(&label, source));
        if !same_inode(&stat(&self.fd)?, &stat(&current)?) {
            return Err(Error::unsafe_path(&label));
        }
        Ok(())
    }

    pub(crate) fn dir(&self, path: &str) -> Result<OwnedFd, Error> {
        let mut fd = directory_at(&self.fd, OsStr::new("."), path)?;
        for name in path.split('/').filter(|part| !part.is_empty()) {
            fd = directory_at(&fd, OsStr::new(name), path)?;
        }
        Ok(fd)
    }

    pub(crate) fn entries(&self, path: &str) -> Result<Dir, Error> {
        Dir::new(self.dir(path)?).map_err(|source| Error::errno(path, source))
    }

    pub(crate) fn stat(&self, path: &RelativePath) -> Result<Option<Stat>, Error> {
        let parent = match self.dir(path.parent()) {
            Ok(parent) => parent,
            Err(error) if error.missing() => return Ok(None),
            Err(error) => return Err(error),
        };
        match statat(&parent, path.name(), AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) if file_type(&stat) == FileType::Symlink => {
                Err(Error::unsafe_path(path.as_str()))
            }
            Ok(stat) => Ok(Some(stat)),
            Err(Errno::NOENT) => Ok(None),
            Err(source) => Err(Error::errno(path.as_str(), source)),
        }
    }

    pub(crate) fn make_parents(&self, path: &RelativePath) -> Result<(), Error> {
        let mut fd = directory_at(&self.fd, OsStr::new("."), path.as_str())?;
        for name in path.parent().split('/').filter(|part| !part.is_empty()) {
            match mkdirat(&fd, name, DIRECTORY_MODE) {
                Ok(()) => fsync(&fd).map_err(|source| Error::errno(path.as_str(), source))?,
                Err(Errno::EXIST) => {}
                Err(source) => return Err(Error::errno(path.as_str(), source)),
            }
            fd = directory_at(&fd, OsStr::new(name), path.as_str())?;
        }
        Ok(())
    }

    pub(crate) fn mkdir(&self, path: &RelativePath) -> Result<(), Error> {
        let parent = self.dir(path.parent())?;
        mkdirat(&parent, path.name(), DIRECTORY_MODE)
            .map_err(|source| Error::errno(path.as_str(), source))?;
        fsync(&parent).map_err(|source| Error::errno(path.as_str(), source))
    }

    pub(crate) fn write_exclusive(&self, path: &RelativePath, bytes: &[u8]) -> Result<(), Error> {
        let label = path.as_str();
        let parent = self.dir(path.parent())?;
        let flags =
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let fd = openat(&parent, path.name(), flags, FILE_MODE)
            .map_err(|source| Error::errno(label, source))?;
        let mut file = File::from(fd);
        file.write_all(bytes)
            .map_err(|source| Error::io(label, source))?;
        file.sync_all().map_err(|source| Error::io(label, source))?;
        fsync(&parent).map_err(|source| Error::errno(label, source))
    }

    pub(crate) fn rename(
        &self,
        from: &RelativePath,
        to: &RelativePath,
        flags: RenameFlags,
    ) -> Result<(), Error> {
        let source = self.dir(from.parent())?;
        let destination = self.dir(to.parent())?;
        if flags.is_empty() {
            renameat(&source, from.name(), &destination, to.name())
        } else {
            renameat_with(&source, from.name(), &destination, to.name(), flags)
        }
        .map_err(|error| Error::errno(to.as_str(), error))?;
        fsync(&destination)
            .and_then(|()| fsync(&source))
            .map_err(|error| Error::errno(to.as_str(), error))
    }

    pub(crate) fn unlink(&self, path: &RelativePath, flags: AtFlags) -> Result<(), Error> {
        let parent = self.dir(path.parent())?;
        unlinkat(&parent, path.name(), flags)
            .map_err(|error| Error::errno(path.as_str(), error))?;
        fsync(&parent).map_err(|error| Error::errno(path.as_str(), error))
    }
}
