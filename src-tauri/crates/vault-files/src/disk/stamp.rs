use std::fmt;
use std::os::fd::{AsFd, OwnedFd};

use rustix::fs::{AtFlags, FileType, Stat, fstat, statat};
#[cfg(target_os = "linux")]
use rustix::fs::{StatxFlags, makedev, statx};
#[cfg(target_os = "linux")]
use rustix::io::Errno;

use super::file_type;
use crate::{RelativePath, VaultFileError as Error};

#[derive(PartialEq, Eq)]
pub struct FileStamp {
    device: u64,
    inode: u64,
    size: i128,
    modified_ns: i128,
    changed_ns: i128,
    created_ns: i128,
}

const fn nanoseconds(seconds: i128, nanoseconds: i128) -> i128 {
    seconds * 1_000_000_000 + nanoseconds
}

impl FileStamp {
    pub(super) fn named(parent: &OwnedFd, path: &RelativePath) -> Result<Self, Error> {
        let flags = AtFlags::SYMLINK_NOFOLLOW;
        #[cfg(target_os = "linux")]
        if let Some(stamp) = Self::extended(parent, path, flags)? {
            return Ok(stamp);
        }
        let stat = statat(parent, path.name(), flags)
            .map_err(|source| Error::errno(path.as_str(), source))?;
        Self::regular(&stat, path)
    }

    pub(super) fn opened(file: &impl AsFd, path: &RelativePath) -> Result<Self, Error> {
        #[cfg(target_os = "linux")]
        if let Some(stamp) = Self::extended(file, path, AtFlags::EMPTY_PATH)? {
            return Ok(stamp);
        }
        let stat = fstat(file).map_err(|source| Error::errno(path.as_str(), source))?;
        Self::regular(&stat, path)
    }

    fn regular(stat: &Stat, path: &RelativePath) -> Result<Self, Error> {
        if file_type(stat) != FileType::RegularFile {
            return Err(Error::unsafe_path(path.as_str()));
        }
        let changed_ns = nanoseconds(stat.st_ctime.into(), stat.st_ctime_nsec.into());
        #[cfg(target_os = "macos")]
        let created_ns = nanoseconds(stat.st_birthtime.into(), stat.st_birthtime_nsec.into());
        #[cfg(target_os = "macos")]
        let device = u64::from_ne_bytes(i64::from(stat.st_dev).to_ne_bytes());
        #[cfg(target_os = "linux")]
        let (created_ns, device) = (changed_ns, stat.st_dev);
        Ok(Self {
            device,
            inode: stat.st_ino,
            size: stat.st_size.into(),
            modified_ns: nanoseconds(stat.st_mtime.into(), stat.st_mtime_nsec.into()),
            changed_ns,
            created_ns,
        })
    }

    #[cfg(target_os = "linux")]
    fn extended(
        fd: &impl AsFd,
        path: &RelativePath,
        flags: AtFlags,
    ) -> Result<Option<Self>, Error> {
        let mask = StatxFlags::BASIC_STATS | StatxFlags::BTIME;
        let name = if flags.contains(AtFlags::EMPTY_PATH) {
            ""
        } else {
            path.name()
        };
        let stat = match statx(fd, name, flags, mask) {
            Ok(stat) => stat,
            // libuv тоже читает обычный stat, если ядро не поддерживает statx.
            Err(Errno::NOSYS | Errno::INVAL | Errno::PERM | Errno::OPNOTSUPP) => return Ok(None),
            Err(source) => return Err(Error::errno(path.as_str(), source)),
        };
        if FileType::from_raw_mode(stat.stx_mode.into()) != FileType::RegularFile {
            return Err(Error::unsafe_path(path.as_str()));
        }
        Ok(Some(Self {
            device: makedev(stat.stx_dev_major, stat.stx_dev_minor),
            inode: stat.stx_ino,
            size: stat.stx_size.into(),
            modified_ns: nanoseconds(stat.stx_mtime.tv_sec.into(), stat.stx_mtime.tv_nsec.into()),
            changed_ns: nanoseconds(stat.stx_ctime.tv_sec.into(), stat.stx_ctime.tv_nsec.into()),
            created_ns: nanoseconds(stat.stx_btime.tv_sec.into(), stat.stx_btime.tv_nsec.into()),
        }))
    }
}

impl fmt::Display for FileStamp {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            output,
            "{}:{}:{}:{}:{}:{}",
            self.device, self.inode, self.size, self.modified_ns, self.changed_ns, self.created_ns
        )
    }
}
