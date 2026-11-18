use std::{collections::HashMap, sync::Arc};

use crate::{
    DocumentInput, FileFailure, ParsedDocument, ProblemCode, SearchError, VaultIndex, VaultProblem,
    VaultReadSource, VaultSearchHit, VaultSnapshot,
    links::populate,
    observations::{Observation, Observations, ScannedTree, StagedFile, VaultScan},
    openable,
    record::{FileRecord, FileText, Records},
    snapshot,
};

#[derive(Debug)]
struct Entry {
    position: usize,
    file: Arc<FileRecord>,
    assets: HashMap<String, Observation>,
}

/// Сверяет проекцию с результатом сканирования. Не открывает файлы Vault.
#[derive(Debug, Default)]
pub struct VaultProjection {
    index: Option<VaultIndex>,
    records: Records,
    paths: Vec<String>,
    folders: Vec<String>,
    entries: HashMap<String, Entry>,
    pages: Vec<Arc<ParsedDocument>>,
    problems: Vec<VaultProblem>,
    tree_version: String,
}

impl VaultProjection {
    /// Создаёт проекцию без постоянного кэша.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Создаёт проекцию с кэшем. Повреждённый кэш не блокирует чтение.
    #[must_use]
    pub fn with_index(mut index: VaultIndex) -> Self {
        let records = index.load();
        Self {
            records,
            index: Some(index),
            ..Self::default()
        }
    }

    /// Возвращает разобранный документ по точному пути.
    pub fn document(&self, path: &str) -> Option<&ParsedDocument> {
        self.entries
            .get(path)
            .and_then(|entry| self.pages.get(entry.position))
            .map(Arc::as_ref)
    }

    /// Возвращает документы в порядке ключей JavaScript.
    pub fn documents(&self) -> impl Iterator<Item = &ParsedDocument> {
        self.pages.iter().map(Arc::as_ref)
    }

    /// Возвращает диагностику сканирования и открываемых файлов.
    pub fn problems(&self) -> &[VaultProblem] {
        &self.problems
    }

    /// Возвращает версию подтверждённого дерева, включая вложения и пустые папки.
    pub fn tree_version(&self) -> &str {
        &self.tree_version
    }

    /// Возвращает снимок списка заметок, файлов, папок и тегов.
    pub fn snapshot(&self, vault_name: Option<&str>) -> VaultSnapshot {
        snapshot::build(self, vault_name, &self.folders)
    }

    /// Ищет Markdown по всем словам запроса и точному тегу.
    ///
    /// # Errors
    /// Возвращает [`SearchError`], если запрос длиннее 500 единиц UTF-16.
    pub fn search(
        &self,
        query: &str,
        tag: Option<&str>,
    ) -> Result<Vec<VaultSearchHit>, SearchError> {
        snapshot::search(self, query, tag)
    }

    /// Применяет подтверждённый результат сканирования, затем обновляет кэш.
    pub fn reconcile(&mut self, scan: VaultScan<'_>, files: &impl VaultReadSource) {
        let records = self.project(scan, files, &[]);
        if let Some(index) = &mut self.index {
            let visible_records = self
                .paths
                .iter()
                .filter_map(|path| {
                    records
                        .get(path)
                        .map(|record| (path.clone(), Arc::clone(record)))
                })
                .collect();
            index.save(visible_records);
        }
        self.records = records;
    }

    /// Показывает подтверждённое дерево с подготовленными изменениями документов.
    /// Версия дерева и SQLite учитывают только подтверждённые байты.
    pub fn reconcile_staged(
        &mut self,
        scan: VaultScan<'_>,
        files: &impl VaultReadSource,
        staged: &[StagedFile<'_>],
    ) {
        self.project(scan, files, staged);
    }

    fn project(
        &mut self,
        scan: VaultScan<'_>,
        files: &impl VaultReadSource,
        staged: &[StagedFile<'_>],
    ) -> Records {
        let mut observations = Observations::new(scan, files, &self.records);
        let ScannedTree {
            paths,
            folders,
            mut problems,
            version,
        } = observations.scan(scan, staged);
        self.tree_version = version;
        self.folders = folders;
        let mut entries = HashMap::new();
        let mut pages = Vec::new();
        let mut graph_changed = self.paths != paths;
        for path in &paths {
            if !openable(path) || observations.is_quarantined(path) {
                continue;
            }
            let Ok(file) = observations.file(path) else {
                continue;
            };
            let (source, syntax) = match &file.text {
                FileText::Document { source, syntax } => (source, syntax),
                FileText::Conflict { .. } => {
                    problems.push(VaultProblem::document(
                        ProblemCode::GitConflict,
                        path,
                        "Обнаружен конфликт Git",
                    ));
                    continue;
                }
                FileText::Invalid { problem } => {
                    problems.push(problem.clone());
                    continue;
                }
                FileText::Binary => continue,
            };
            let mut assets = HashMap::new();
            for embed in syntax.spans.iter().filter_map(|span| span.embed.as_ref()) {
                assets
                    .entry(embed.path.clone())
                    .or_insert_with(|| observations.file(&embed.path));
            }
            let old = self
                .entries
                .get(path)
                .and_then(|entry| self.pages.get(entry.position).map(|page| (entry, page)));
            let parsed = if let Some((_, page)) =
                old.filter(|(entry, _)| Arc::ptr_eq(&file, &entry.file) && assets == entry.assets)
            {
                Arc::clone(page)
            } else {
                let input = DocumentInput {
                    path,
                    source,
                    times: file.times(),
                };
                let mut page = ParsedDocument::materialize(
                    input,
                    Arc::clone(syntax),
                    |asset_path| match assets.get(asset_path) {
                        Some(Ok(record)) => record.asset().map_err(|code| FileFailure {
                            code,
                            message: String::new(),
                        }),
                        Some(Err(failure)) => Err(failure.clone()),
                        None => Err(FileFailure {
                            code: ProblemCode::UnreadableFile,
                            message: String::new(),
                        }),
                    },
                );
                if let Some((_, previous)) =
                    old.filter(|(_, previous)| previous.same_graph_input(&page))
                {
                    page.set_graph(
                        previous.links().to_vec(),
                        previous.document().backlinks.clone(),
                    );
                } else {
                    graph_changed = true;
                }
                Arc::new(page)
            };
            problems.extend_from_slice(parsed.problems());
            entries.insert(
                path.clone(),
                Entry {
                    position: pages.len(),
                    file,
                    assets,
                },
            );
            pages.push(parsed);
        }
        if graph_changed || self.entries.len() != entries.len() {
            populate(&mut pages, &paths);
        }
        self.entries = entries;
        self.pages = pages;
        self.problems = problems;
        self.paths = paths;
        observations.into_records()
    }
}
