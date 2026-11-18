use std::collections::BTreeSet;

use rustix::fs::FileType;
use unicode_normalization::UnicodeNormalization;

use crate::disk::{Disk, file_type, same_inode};
use crate::{
    RelativePath, VaultFileError as Error, VaultFileProblem, VaultFileProblemCode, VaultFiles,
};

const IGNORE_FILE: &str = ".livenoteignore";

/// Список видимых путей, скрытых записей и ошибок чтения каталогов.
#[derive(Debug, Default)]
pub struct VaultListing {
    pub files: Vec<String>,
    pub folders: Vec<String>,
    pub ignored_folders: Vec<String>,
    pub hidden_entries: Vec<String>,
    pub problems: Vec<VaultFileProblem>,
}

#[derive(Default)]
pub struct IgnoreRules(BTreeSet<String>);

impl IgnoreRules {
    pub(crate) fn read(disk: &Disk) -> Result<Self, Error> {
        let Some(file) = disk.read_optional(&RelativePath::new(IGNORE_FILE)?)? else {
            return Ok(Self::default());
        };
        let source = std::str::from_utf8(&file.bytes).map_err(|error| {
            Error::io(
                IGNORE_FILE,
                std::io::Error::new(std::io::ErrorKind::InvalidData, error),
            )
        })?;
        let source = source.strip_prefix('\u{feff}').unwrap_or(source);
        let rules = source.lines().filter_map(|line| {
            let line = line.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}');
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let line = line.strip_prefix('/').unwrap_or(line);
            let line = line.strip_suffix('/').unwrap_or(line);
            let path: String = line.nfc().collect();
            (!path.contains(['\0', '\\'])
                && !path.split('/').any(|part| matches!(part, "" | "." | "..")))
            .then_some(path)
        });
        Ok(Self(rules.collect()))
    }

    fn matching_parent(&self, path: &str, directory: bool) -> bool {
        let normalized: String = path.nfc().collect();
        let mut parent = if directory {
            normalized.as_str()
        } else {
            normalized.rsplit_once('/').map_or("", |(parent, _)| parent)
        };
        while !parent.is_empty() {
            if self.0.contains(parent) {
                return true;
            }
            parent = parent.rsplit_once('/').map_or("", |(ancestor, _)| ancestor);
        }
        false
    }

    pub(crate) fn assert_visible(
        &self,
        disk: &Disk,
        path: &RelativePath,
        directory: bool,
    ) -> Result<(), Error> {
        let raw = path.as_str();
        if self.matching_parent(raw, directory) {
            return Err(Error::invalid(raw));
        }
        // На ФС без учёта регистра разные имена могут указывать на один каталог.
        let mut parent = if directory { raw } else { path.parent() };
        while !parent.is_empty() {
            let folded: String = parent.nfc().flat_map(char::to_lowercase).collect();
            for rule in &self.0 {
                if rule.to_lowercase() == folded {
                    let candidate = disk.stat(&RelativePath::new(parent)?)?;
                    let hidden = disk.stat(&RelativePath::new(rule)?)?;
                    if let (Some(candidate), Some(hidden)) = (candidate, hidden)
                        && file_type(&candidate) == FileType::Directory
                        && same_inode(&candidate, &hidden)
                    {
                        return Err(Error::invalid(raw));
                    }
                }
            }
            parent = parent.rsplit_once('/').map_or("", |(ancestor, _)| ancestor);
        }
        Ok(())
    }
}

impl VaultFiles {
    /// Перечисляет хранилище с учётом `.livenoteignore`. Git-правила принадлежат Git.
    ///
    /// # Errors
    /// Возвращает ошибку, если корень хранилища заменили.
    pub fn list(&self) -> Result<VaultListing, Error> {
        self.list_in("", false)
    }

    /// Перечисляет подкаталог. Служебный режим включает скрытые пути.
    ///
    /// # Errors
    /// Возвращает ошибку, если путь или корень небезопасен.
    pub fn list_in(
        &self,
        directory: &str,
        include_operational: bool,
    ) -> Result<VaultListing, Error> {
        self.disk.check_root()?;
        if !directory.is_empty() {
            let path = RelativePath::new(directory)?;
            if !include_operational {
                path.author_path(false)?;
            }
        }
        let mut listing = VaultListing {
            folders: vec![directory.into()],
            ..VaultListing::default()
        };
        let rules = if include_operational {
            None
        } else {
            match IgnoreRules::read(&self.disk) {
                Ok(rules) => Some(rules),
                Err(error) => {
                    listing.problems.push(error.problem(IGNORE_FILE));
                    Some(IgnoreRules::default())
                }
            }
        };
        listing.walk(&self.disk, directory, rules.as_ref());
        listing
            .files
            .sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        listing
            .folders
            .sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        listing.ignored_folders.sort();
        listing.hidden_entries.sort();
        Ok(listing)
    }
}

impl VaultListing {
    fn walk(&mut self, disk: &Disk, directory: &str, rules: Option<&IgnoreRules>) {
        let mut pending = vec![directory.to_owned()];
        while let Some(directory) = pending.pop() {
            let directory_entries = match disk.entries(&directory) {
                Ok(entries) => entries,
                Err(error) => {
                    self.problems.push(error.problem(&directory));
                    continue;
                }
            };
            for entry in directory_entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        self.problems
                            .push(Error::errno(&directory, error).problem(&directory));
                        break;
                    }
                };
                let name = entry.file_name();
                if matches!(name.to_bytes(), b"." | b"..") {
                    continue;
                }
                let name = name.to_string_lossy();
                let child = if directory.is_empty() {
                    name.to_string()
                } else {
                    format!("{directory}/{name}")
                };
                if rules.is_some() && child == IGNORE_FILE {
                    continue;
                }
                if rules.is_some() && matches!(name.as_ref(), ".git" | ".livenote") {
                    self.hidden_entries.push(child);
                    continue;
                }
                let Ok(path) = RelativePath::new(&child) else {
                    self.problems
                        .push(Error::unsafe_path(&child).problem(&child));
                    continue;
                };
                if entry.file_name().to_str().is_err() {
                    self.problems.push(VaultFileProblem {
                        path: child,
                        code: VaultFileProblemCode::UnreadableFile,
                        message: "Имя файла не является строкой UTF-8".into(),
                    });
                    continue;
                }
                match disk.stat(&path) {
                    Ok(Some(stat)) => match file_type(&stat) {
                        FileType::Directory
                            if rules.is_some_and(|rules| rules.matching_parent(&child, true)) =>
                        {
                            self.ignored_folders.push(child.clone());
                            self.hidden_entries.push(child);
                        }
                        FileType::Directory => {
                            self.folders.push(child.clone());
                            pending.push(child);
                        }
                        FileType::RegularFile => self.files.push(child),
                        // Специальные файлы не входят в проекцию.
                        _ => {}
                    },
                    Ok(None) => {}
                    Err(error) => self.problems.push(error.problem(&child)),
                }
            }
        }
    }
}
