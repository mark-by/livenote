use std::{
    fs::{self, Metadata},
    io,
    path::{Path, PathBuf},
    time::SystemTime,
};

use crate::index::CacheError;

pub(crate) fn canonical_directory(path: &Path) -> io::Result<PathBuf> {
    match path.canonicalize() {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let (Some(name), Some(parent)) = (path.file_name(), path.parent()) else {
                return Err(error);
            };
            let parent = if parent.as_os_str().is_empty() {
                Path::new(".")
            } else {
                parent
            };
            Ok(canonical_directory(parent)?.join(name))
        }
        Err(error) => Err(error),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stamp {
    modified: SystemTime,
    size: u64,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

pub(crate) fn cache_stamp(path: &Path) -> Result<Option<Stamp>, CacheError> {
    let stat = match fs::symlink_metadata(path) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !stat.is_file() {
        return Err(CacheError::Invalid);
    }
    Ok(Some(Stamp::from_metadata(&stat)?))
}

impl Stamp {
    fn from_metadata(stat: &Metadata) -> Result<Self, CacheError> {
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            if stat.nlink() != 1 {
                return Err(CacheError::Invalid);
            }
            (stat.dev(), stat.ino(), stat.ctime(), stat.ctime_nsec())
        };
        Ok(Self {
            modified: stat.modified()?,
            size: stat.len(),
            #[cfg(unix)]
            identity,
        })
    }
}
