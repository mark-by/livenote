use rustix::fs::FileType;

use crate::disk::file_type;
use crate::journal::{FinishedJournal, Journal, TRANSACTIONS};
use crate::publication::{Mode, Publication};
use crate::{
    DirectoryChange, FileWrite, PathRename, RelativePath, StagedTimes, VaultFileError as Error,
    VaultFileProblem, VaultFileProblemCode, VaultFiles,
};

impl VaultFiles {
    /// Публикует файлы, каталоги и переименование через совместимый журнал.
    ///
    /// Возвращает `false`, если запрос не меняет состояние. Ошибка уборки
    /// подтверждённого журнала не меняет результат записи.
    ///
    /// # Errors
    /// Возвращает ошибку пути, конфликт ожидаемых байтов или сбой публикации.
    pub fn commit(
        &mut self,
        writes: &[FileWrite<'_>],
        directories: &[DirectoryChange],
        rename: Option<&PathRename>,
    ) -> Result<bool, Error> {
        self.disk.check_root()?;
        let journal = self.plan(writes, directories, rename)?;
        if journal.paths().next().is_none() {
            return Ok(false);
        }
        journal.persist(&self.disk)?;
        self.publish(&journal)?;
        Ok(true)
    }

    /// Готовит записи файлов, формирует квитанцию по их временам и публикует всё одним журналом.
    ///
    /// # Errors
    /// Внешний результат содержит ошибку файловой операции. Внутренний содержит
    /// ошибку формирования квитанции до публикации.
    pub fn commit_with_receipt<T, E>(
        &mut self,
        writes: &[FileWrite<'_>],
        receipt_path: &RelativePath,
        build: impl FnOnce(&Self, &[StagedTimes<'_>]) -> Result<(Vec<u8>, T), E>,
    ) -> Result<Result<T, E>, Error> {
        self.disk.check_root()?;
        if !receipt_path.as_str().starts_with(".livenote/requests/")
            || writes.iter().any(|write| write.path.operational_write())
        {
            return Err(Error::invalid(receipt_path.as_str()));
        }
        let mut journal = self.plan(writes, &[], None)?;
        let stage = journal.stage(&self.disk)?;
        let previous = self.disk.read_optional(receipt_path)?;
        let (bytes, response) = match build(self, &stage.times(&journal)?) {
            Ok(pair) => pair,
            Err(error) => return Ok(Err(error)),
        };
        let receipt = FileWrite {
            path: receipt_path.clone(),
            source: Some(&bytes),
            expected: previous.as_ref().map(|file| file.bytes.as_slice()),
        };
        let extra = self.plan(&[receipt], &[], None)?;
        let start = journal.changes.len();
        journal.changes.extend(extra.changes);
        journal.directories.extend(extra.directories);
        if journal.paths().next().is_none() {
            return Ok(Ok(response));
        }
        journal.preserve_staged = true;
        journal.validate()?;
        stage.write_changes(&journal, start)?;
        stage.activate(&journal)?;
        self.publish(&journal)?;
        Ok(Ok(response))
    }

    fn publish(&mut self, journal: &Journal) -> Result<(), Error> {
        let mut publication = Publication::new(&self.disk, journal);
        if let Err(source) = publication.apply(Mode::Commit) {
            let rollback = publication.rollback().err().map(Box::new);
            return Err(self.incomplete(journal, source, rollback));
        }
        let finished = journal.confirm(&self.disk).map_err(|source| {
            // Журнал уже мог сменить имя. Не откатываем опубликованные файлы.
            self.incomplete(journal, source, None)
        })?;
        finished.cleanup(&self.disk);
        Ok(())
    }

    fn incomplete(
        &mut self,
        journal: &Journal,
        source: Error,
        rollback: Option<Box<Error>>,
    ) -> Error {
        self.quarantine(journal);
        Error::TransactionIncomplete {
            id: journal.id.clone(),
            paths: journal.paths().map(|path| path.as_str().into()).collect(),
            source: Box::new(source),
            rollback,
        }
    }

    pub(crate) fn reject_quarantined<'a>(
        &self,
        paths: impl IntoIterator<Item = &'a RelativePath>,
    ) -> Result<(), Error> {
        for path in paths {
            if self
                .quarantined
                .iter()
                .any(|other| path.suffix_of(other).is_some() || other.suffix_of(path).is_some())
            {
                return Err(Error::stale(path.as_str()));
            }
        }
        Ok(())
    }

    fn quarantine(&mut self, journal: &Journal) {
        for path in journal.paths() {
            if !self.quarantined.contains(path) {
                self.quarantined.push(path.clone());
                if path.operational_write() {
                    continue;
                }
                self.recovery_problems.push(VaultFileProblem {
                    path: path.as_str().into(),
                    code: VaultFileProblemCode::UnreadableFile,
                    message: format!("Незавершённая транзакция {}. Сохраните обе версии и восстановите данные вручную.", journal.id),
                });
            }
        }
    }

    pub(crate) fn recover(&mut self) -> Result<(), Error> {
        if let Err(error) = FinishedJournal::retry_all(&self.disk) {
            eprintln!("Не удалось повторить уборку завершённых транзакций: {error}");
        }
        let entries = match self.disk.entries(TRANSACTIONS) {
            Ok(entries) => entries,
            Err(error) if error.missing() => return Ok(()),
            Err(error) => return Err(error),
        };
        // Проверяем формат всех журналов до записи первого пользовательского файла.
        let mut journals = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| Error::errno(TRANSACTIONS, error))?;
            let name = entry.file_name();
            if matches!(name.to_bytes(), b"." | b"..") {
                continue;
            }
            let id = name
                .to_str()
                .map_err(|_| Error::unsafe_path(TRANSACTIONS))?;
            let directory = RelativePath::new(&format!("{TRANSACTIONS}/{id}"))?;
            let stat = self
                .disk
                .stat(&directory)?
                .ok_or_else(|| Error::unsafe_path(directory.as_str()))?;
            if file_type(&stat) != FileType::Directory {
                return Err(Error::unsafe_path(directory.as_str()));
            }
            let path = RelativePath::new(&format!("{}/journal.json", directory.as_str()))?;
            journals.push(Journal::read(&self.disk, id, &path)?);
        }
        journals.sort_by(|a, b| a.id.cmp(&b.id));
        for journal in journals {
            if self.reject_quarantined(journal.paths()).is_err() {
                self.quarantine(&journal);
                continue;
            }
            let mut publication = Publication::new(&self.disk, &journal);
            if publication.apply(Mode::Recover).is_err() {
                self.quarantine(&journal);
                continue;
            }
            journal.confirm(&self.disk)?.cleanup(&self.disk);
        }
        Ok(())
    }
}
