use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::OwnedFd;

use rustix::fs::{
    AtFlags, FlockOperation, Mode, OFlags, RenameFlags, flock, fsync, openat, renameat_with,
    unlinkat,
};
use rustix::io::Errno;
use rustix::process::{Pid, test_kill_process};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::disk::Disk;
use crate::{RelativePath, VaultFileError as Error};

const STATE_DIR: &str = ".livenote";
const LOCK: &str = "lock";
const LABEL: &str = ".livenote/lock";

#[derive(Deserialize)]
struct Prior {
    pid: i32,
}

#[derive(Serialize)]
struct Identity<'a> {
    pid: u32,
    nonce: &'a str,
}

#[derive(Debug)]
pub struct WriterLock {
    dir: OwnedFd,
    identity: Vec<u8>,
}

fn current(dir: &OwnedFd) -> Result<Option<Vec<u8>>, Error> {
    let flags = OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let fd = match openat(dir, LOCK, flags, Mode::empty()) {
        Ok(fd) => fd,
        Err(Errno::NOENT) => return Ok(None),
        Err(error) => return Err(Error::errno(LABEL, error)),
    };
    let mut file = File::from(fd);
    if !file
        .metadata()
        .map_err(|error| Error::io(LABEL, error))?
        .is_file()
    {
        return Err(Error::unsafe_path(LABEL));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| Error::io(LABEL, error))?;
    Ok(Some(bytes))
}

impl WriterLock {
    pub(crate) fn acquire(disk: &Disk) -> Result<Self, Error> {
        disk.make_parents(&RelativePath::new(LABEL)?)?;
        // Параллельные открытия Rust не могут одновременно удалить устаревшую блокировку.
        let guard = disk.dir(STATE_DIR)?;
        flock(&guard, FlockOperation::NonBlockingLockExclusive).map_err(|error| {
            if error == Errno::WOULDBLOCK {
                Error::Locked
            } else {
                Error::errno(LABEL, error)
            }
        })?;
        if let Some(bytes) = current(&guard)? {
            let prior: Prior = serde_json::from_slice(&bytes).map_err(|_| Error::Locked)?;
            let pid = Pid::from_raw(prior.pid)
                .filter(|pid| pid.as_raw_nonzero().get() > 0)
                .ok_or(Error::Locked)?;
            match test_kill_process(pid) {
                Ok(()) | Err(Errno::PERM) => return Err(Error::Locked),
                Err(Errno::SRCH) => {}
                Err(error) => return Err(Error::errno(LABEL, error)),
            }
            if current(&guard)?.as_deref() != Some(bytes.as_slice()) {
                return Err(Error::Locked);
            }
            unlinkat(&guard, LOCK, AtFlags::empty()).map_err(|error| Error::errno(LABEL, error))?;
        }
        let nonce = Uuid::new_v4().to_string();
        let identity = serde_json::to_vec(&Identity {
            pid: std::process::id(),
            nonce: &nonce,
        })
        .map_err(|error| Error::io(LABEL, error.into()))?;
        let temp = format!(".lock-{nonce}");
        let flags =
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mode = Mode::from_bits_truncate(0o600);
        let fd = openat(&guard, temp.as_str(), flags, mode)
            .map_err(|error| Error::errno(LABEL, error))?;
        let mut file = File::from(fd);
        let publish =
            file.write_all(&identity)
                .and_then(|()| file.sync_all())
                .map_err(|error| Error::io(LABEL, error))
                .and_then(|()| {
                    renameat_with(&guard, temp.as_str(), &guard, LOCK, RenameFlags::NOREPLACE)
                        .map_err(|error| {
                            if error == Errno::EXIST {
                                Error::Locked
                            } else {
                                Error::errno(LABEL, error)
                            }
                        })
                });
        if let Err(error) = publish {
            if let Err(cleanup) = unlinkat(&guard, temp.as_str(), AtFlags::empty()) {
                eprintln!("Не удалось убрать временную блокировку: {cleanup}");
            }
            return Err(error);
        }
        let lock = Self {
            dir: guard,
            identity,
        };
        fsync(&lock.dir).map_err(|error| Error::errno(LABEL, error))?;
        Ok(lock)
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let release = current(&self.dir).and_then(|current| {
            if current.as_deref() == Some(self.identity.as_slice()) {
                unlinkat(&self.dir, LOCK, AtFlags::empty())
                    .and_then(|()| fsync(&self.dir))
                    .map_err(|error| Error::errno(LABEL, error))?;
            }
            Ok(())
        });
        if let Err(error) = release {
            eprintln!("Не удалось снять блокировку vault: {error}");
        }
    }
}
