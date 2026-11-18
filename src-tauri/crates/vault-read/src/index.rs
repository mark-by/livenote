use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension, params};

use crate::{
    record::{FileRecord, Records},
    sha256, vault_cache_path,
};

use crate::index_location::{Stamp, cache_stamp, canonical_directory};

const SCHEMA_VERSION: u32 = 2;

/// Хранит пересоздаваемую проекцию в системном каталоге кэша.
#[derive(Debug)]
pub struct VaultIndex {
    path: PathBuf,
    root: String,
    persisted: Records,
    stamp: Option<Stamp>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum CacheError {
    #[error("Неподходящий индекс Vault")]
    Invalid,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl VaultIndex {
    /// Выбирает `index.sqlite` по каноническому корню Vault. Не открывает базу.
    #[must_use]
    pub fn new(cache_home: &Path, canonical_root: &str) -> Self {
        Self {
            path: vault_cache_path(canonical_root, cache_home),
            root: canonical_root.to_owned(),
            persisted: Records::new(),
            stamp: None,
        }
    }

    /// Возвращает системный путь базы кэша.
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn load(&mut self) -> Records {
        if let Ok(Some((records, stamp))) = self.read_database() {
            self.stamp = Some(stamp);
            self.persisted = records;
        }
        self.persisted.clone()
    }

    pub(crate) fn save(&mut self, records: Records) {
        match self.write_database(&records) {
            Ok(stamp) => {
                self.stamp = Some(stamp);
                self.persisted = records;
            }
            Err(_) => self.stamp = None,
        }
    }

    fn location(&self) -> Result<PathBuf, CacheError> {
        let directory = canonical_directory(self.path.parent().ok_or(CacheError::Invalid)?)?;
        if directory.starts_with(Path::new(&self.root)) {
            return Err(CacheError::Invalid);
        }
        Ok(directory.join("index.sqlite"))
    }

    fn read_database(&self) -> Result<Option<(Records, Stamp)>, CacheError> {
        let path = self.location()?;
        let Some(stamp) = cache_stamp(&path)? else {
            return Ok(None);
        };
        let db = connect(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        if schema_version(&db)? != SCHEMA_VERSION || db_root(&db)?.as_deref() != Some(&self.root) {
            return Err(CacheError::Invalid);
        }
        let mut query = db.prepare("SELECT path, payload, checksum FROM files")?;
        let rows = query.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut records = Records::new();
        for row in rows {
            let (path, payload, expected) = row?;
            if checksum(&path, &payload) != expected {
                return Err(CacheError::Invalid);
            }
            let file: FileRecord = serde_json::from_str(&payload)?;
            records.insert(path, Arc::new(file));
        }
        if cache_stamp(&path)? != Some(stamp) {
            return Err(CacheError::Invalid);
        }
        Ok(Some((records, stamp)))
    }

    fn write_database(&self, records: &Records) -> Result<Stamp, CacheError> {
        let path = self.location()?;
        let stamp = cache_stamp(&path)?;
        if let Some(stamp) = stamp.filter(|stamp| Some(*stamp) == self.stamp) {
            let changed = records
                .iter()
                .filter(|(path, file)| {
                    !self
                        .persisted
                        .get(*path)
                        .is_some_and(|old| Arc::ptr_eq(old, file))
                })
                .collect::<Vec<_>>();
            let removed = self
                .persisted
                .keys()
                .filter(|path| !records.contains_key(*path))
                .collect::<Vec<_>>();
            if changed.is_empty() && removed.is_empty() {
                return Ok(stamp);
            }
            let mut db = connect(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
            if schema_version(&db)? != SCHEMA_VERSION
                || db_root(&db)?.as_deref() != Some(&self.root)
            {
                return Err(CacheError::Invalid);
            }
            write_records(&mut db, changed, removed)?;
        } else {
            self.replace(&path, stamp, records)?;
        }
        cache_stamp(&path)?.ok_or(CacheError::Invalid)
    }

    fn replace(
        &self,
        path: &Path,
        expected: Option<Stamp>,
        records: &Records,
    ) -> Result<(), CacheError> {
        if expected.is_some() {
            let owned = connect(path, OpenFlags::SQLITE_OPEN_READ_ONLY).and_then(|db| {
                let version = schema_version(&db)?;
                Ok(matches!(version, 1 | SCHEMA_VERSION)
                    && db_root(&db)?.as_deref() == Some(&self.root))
            });
            match owned {
                Ok(true) => (),
                Err(CacheError::Sql(rusqlite::Error::SqliteFailure(error, _)))
                    if matches!(
                        error.code,
                        ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt
                    ) => {}
                _ => return Err(CacheError::Invalid),
            }
        }
        let directory = path.parent().ok_or(CacheError::Invalid)?;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(directory)?;
        let temp = tempfile::Builder::new()
            .prefix(".index-")
            .tempdir_in(directory)?;
        let next = temp.path().join("index.sqlite");
        let mut db = connect(
            &next,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        db.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        db.execute_batch("CREATE TABLE vault (root TEXT NOT NULL);\
            CREATE TABLE files (path TEXT PRIMARY KEY, payload TEXT NOT NULL, checksum TEXT NOT NULL) WITHOUT ROWID;")?;
        db.execute("INSERT INTO vault VALUES (?)", [&self.root])?;
        write_records(&mut db, records, [])?;
        db.close().map_err(|(_, error)| error)?;
        if cache_stamp(path)? != expected {
            return Err(CacheError::Invalid);
        }
        fs::rename(next, path)?;
        Ok(())
    }
}

fn write_records<'a>(
    db: &mut Connection,
    records: impl IntoIterator<Item = (&'a String, &'a Arc<FileRecord>)>,
    removed: impl IntoIterator<Item = &'a String>,
) -> Result<(), CacheError> {
    let tx = db.transaction()?;
    {
        let mut delete = tx.prepare("DELETE FROM files WHERE path = ?")?;
        let mut insert = tx.prepare("INSERT OR REPLACE INTO files VALUES (?, ?, ?)")?;
        for path in removed {
            delete.execute([path])?;
        }
        for (path, file) in records {
            let payload = serde_json::to_string(file)?;
            let digest = checksum(path, &payload);
            insert.execute(params![path, payload, digest])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn connect(path: &Path, flags: OpenFlags) -> Result<Connection, CacheError> {
    let db = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NOFOLLOW)?;
    db.busy_timeout(Duration::ZERO)?;
    Ok(db)
}

fn schema_version(db: &Connection) -> rusqlite::Result<u32> {
    db.pragma_query_value(None, "user_version", |row| row.get(0))
}

fn db_root(db: &Connection) -> rusqlite::Result<Option<String>> {
    db.query_row("SELECT root FROM vault", [], |row| row.get(0))
        .optional()
}

fn checksum(path: &str, payload: &str) -> String {
    sha256(format!("{path}\0{payload}").as_bytes())
}
