use crate::{
    FileBytes, FileFailure, FileTimes, ProblemCode, VaultProblem, VaultReadSource, file_version,
    links::utf16_cmp,
    openable,
    record::{FileRecord, Records},
};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use unicode_normalization::UnicodeNormalization;

/// Результат безопасного сканирования. Пути используют разделитель POSIX.
#[derive(Debug, Clone, Copy, Default)]
pub struct VaultScan<'a> {
    pub files: &'a [String],
    pub folders: &'a [String],
    pub problems: &'a [VaultProblem],
    pub recovery_problems: &'a [VaultProblem],
    pub ignored_folders: &'a [String],
}

/// Подготовленные байты. `None` означает удаление.
#[derive(Debug, Clone, Copy)]
pub struct StagedFile<'a> {
    pub path: &'a str,
    pub source: Option<&'a [u8]>,
}

pub(crate) type Observation = Result<Arc<FileRecord>, FileFailure>;

pub(crate) struct Observations<'a, S> {
    previous: &'a Records,
    files: &'a S,
    quarantined: HashMap<&'a str, &'a VaultProblem>,
    observed: HashMap<String, Observation>,
    changes: HashMap<&'a str, Observation>,
}

pub(crate) struct ScannedTree {
    pub(crate) folders: Vec<String>,
    pub(crate) paths: Vec<String>,
    pub(crate) problems: Vec<VaultProblem>,
    pub(crate) version: String,
}

impl<'a, S: VaultReadSource> Observations<'a, S> {
    pub(crate) fn new(scan: VaultScan<'a>, files: &'a S, previous: &'a Records) -> Self {
        let quarantined = scan
            .recovery_problems
            .iter()
            .map(|problem| (problem.path.as_str(), problem))
            .collect();
        Self {
            previous,
            files,
            quarantined,
            observed: HashMap::new(),
            changes: HashMap::new(),
        }
    }

    fn observe(&mut self, path: &str) -> Observation {
        self.observed
            .entry(path.to_owned())
            .or_insert_with(|| {
                if let Some(problem) = self.quarantined.get(path) {
                    return Err(FileFailure {
                        code: problem.code,
                        message: problem.message.clone(),
                    });
                }
                let stamp = self.files.stamp(path)?;
                if let Some(old) = self.previous.get(path).filter(|old| old.stamp == stamp) {
                    return Ok(Arc::clone(old));
                }
                Ok(Arc::new(FileRecord::parse(
                    path,
                    self.files.read_bytes(path)?,
                )))
            })
            .clone()
    }

    pub(crate) fn scan(
        &mut self,
        scan: VaultScan<'_>,
        staged: &'a [StagedFile<'a>],
        staged_times: impl Fn(&str) -> FileTimes,
    ) -> ScannedTree {
        let mut problems = scan.problems.to_vec();
        problems.extend(
            scan.recovery_problems
                .iter()
                .filter(|p| !ignored(&p.path, scan.ignored_folders))
                .cloned(),
        );
        let mut paths = scan.files.to_vec();
        paths.sort_by(|a, b| utf16_cmp(a, b));
        let versions: Vec<_> = paths
            .iter()
            .map(|path| {
                let version = match self.observe(path) {
                    Ok(record) => record.version.clone(),
                    Err(failure) => {
                        if !self.quarantined.contains_key(path.as_str()) {
                            let code = if failure.code == ProblemCode::MissingAsset {
                                ProblemCode::UnreadableFile
                            } else {
                                failure.code
                            };
                            problems.push(VaultProblem {
                                code,
                                path: path.clone(),
                                message: failure.message,
                                page_id: openable(path).then(|| path.clone()),
                                block_id: None,
                            });
                        }
                        if failure.code == ProblemCode::MissingAsset {
                            "missing"
                        } else {
                            failure.code.as_str()
                        }
                        .to_owned()
                    }
                };
                (path.as_str(), version)
            })
            .collect();
        let mut folders = scan.folders.to_vec();
        folders.sort_by(|a, b| utf16_cmp(a, b));
        #[expect(
            clippy::expect_used,
            reason = "JSON массивов строк всегда сериализуется"
        )]
        let tree = serde_json::to_vec(&(&folders, versions)).expect("вход версии дерева");
        let version = file_version(&tree);

        if !staged.is_empty() {
            let mut present: HashSet<_> = paths.into_iter().collect();
            for file in staged {
                if !openable(file.path)
                    || file.path.starts_with(".livenote/")
                    || ignored(file.path, scan.ignored_folders)
                {
                    continue;
                }
                let observation = match file.source {
                    Some(source) => {
                        present.insert(file.path.to_owned());
                        let bytes = FileBytes {
                            bytes: source.to_vec(),
                            stamp: String::new(),
                            times: staged_times(file.path),
                        };
                        Ok(Arc::new(FileRecord::parse(file.path, bytes)))
                    }
                    None => {
                        present.remove(file.path);
                        Err(FileFailure {
                            code: ProblemCode::MissingAsset,
                            message: "Файл удалён".to_owned(),
                        })
                    }
                };
                self.changes.insert(file.path, observation);
            }
            paths = present.into_iter().collect();
            paths.sort_by(|a, b| utf16_cmp(a, b));
        }

        ScannedTree {
            folders,
            paths,
            problems,
            version,
        }
    }

    pub(crate) fn is_quarantined(&self, path: &str) -> bool {
        self.quarantined.contains_key(path)
    }

    pub(crate) fn file(&mut self, path: &str) -> Observation {
        self.changes
            .get(path)
            .cloned()
            .unwrap_or_else(|| self.observe(path))
    }

    pub(crate) fn into_records(self) -> Records {
        self.observed
            .into_iter()
            .filter_map(|(path, result)| result.ok().map(|file| (path, file)))
            .collect()
    }
}

fn ignored(path: &str, folders: &[String]) -> bool {
    let normalized: String = path.nfc().collect();
    folders
        .iter()
        .map(|folder| folder.nfc().collect::<String>())
        .any(|folder| {
            normalized
                .strip_prefix(&folder)
                .is_some_and(|suffix| suffix.starts_with('/'))
        })
}
