use std::{cell::Cell, fs};

use rustix::io::Errno;
use tempfile::tempdir;

use crate::{FileWrite, RelativePath, VaultFileError, VaultFiles};

type TestResult = Result<(), Box<dyn std::error::Error>>;

const R1_NOTE: &str = "R1-Replace.md";
const R2_NOTE: &str = "R2-Retirement.md";

type PathMatch = fn(&str) -> bool;

thread_local! {
    static SYNC_FAILURE: Cell<Option<PathMatch>> = const { Cell::new(None) };
    static UNLINK_FAILURE: Cell<Option<PathMatch>> = const { Cell::new(None) };
}

pub(crate) fn fail_sync(path: &str) -> Result<(), VaultFileError> {
    SYNC_FAILURE.with(|fault| fail_once(fault, path))
}

pub(crate) fn fail_unlink(path: &str) -> Result<(), VaultFileError> {
    UNLINK_FAILURE.with(|fault| fail_once(fault, path))
}

fn fail_once(fault: &Cell<Option<PathMatch>>, path: &str) -> Result<(), VaultFileError> {
    if fault.get().is_some_and(|matches| matches(path)) {
        fault.set(None);
        return Err(VaultFileError::errno(path, Errno::IO));
    }
    Ok(())
}

#[test]
fn r1_restores_original_bytes_after_replacement_sync_failure() -> TestResult {
    // Arrange: заметка на диске, ошибка только при синхронизации её замены.
    let root = tempdir()?;
    let note = root.path().join(R1_NOTE);
    let original = b"# Old\r\n\r\nOriginal bytes\r\n";
    fs::write(&note, original)?;
    let mut vault = VaultFiles::open(root.path())?;
    let writes = [FileWrite {
        path: RelativePath::new(R1_NOTE)?,
        expected: Some(original),
        source: Some(b"# New\n\nReplacement bytes\n"),
    }];
    SYNC_FAILURE.set(Some(|path| path == R1_NOTE));

    // Act: публикация меняет каталог, затем получает EIO от fsync.
    let result = vault.commit(&writes, &[], None);

    // Assert: к моменту ответа откат вернул исходные байты.
    assert!(matches!(
        result,
        Err(VaultFileError::TransactionIncomplete { source, rollback: None, .. })
            if matches!(source.as_ref(), VaultFileError::Io { path, source }
                if path == R1_NOTE && source.raw_os_error() == Some(Errno::IO.raw_os_error()))
    ));
    assert_eq!(fs::read(&note)?, original);
    Ok(())
}

#[test]
fn r2_reports_success_and_retries_only_cleanup_after_finished_artifact_unlink_failure() -> TestResult
{
    // Arrange: удаление journal.json в завершённом журнале вернёт EIO один раз.
    let root = tempdir()?;
    let note = root.path().join(R2_NOTE);
    let metadata = root.path().join(".livenote");
    let original = b"# Old\n";
    let published = b"# Committed\n";
    fs::write(&note, original)?;
    let mut vault = VaultFiles::open(root.path())?;
    let writes = [FileWrite {
        path: RelativePath::new(R2_NOTE)?,
        expected: Some(original),
        source: Some(published),
    }];
    UNLINK_FAILURE.set(Some(|path| {
        path.starts_with(".livenote/.finished-") && path.ends_with("/journal.json")
    }));

    // Act: сохраняем заметку с ошибкой уборки после подтверждения.
    let result = vault.commit(&writes, &[], None);

    // Assert: ответ успешен, а журнал больше не доступен для повтора записи.
    assert_eq!(fs::read(&note)?, published);
    assert!(!UNLINK_FAILURE.with(|fault| fault.get().is_some()));
    assert!(result?, "Публикация изменила заметку");
    assert!(vault.recovery_problems().is_empty());
    assert_eq!(fs::read_dir(metadata.join("transactions"))?.count(), 0);
    let finished = fs::read_dir(&metadata)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .find(|entry| {
            entry
                .file_name()
                .as_encoded_bytes()
                .starts_with(b".finished-")
        })
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))?
        .path();
    assert!(finished.join("journal.json").is_file());

    // Act: редактор меняет файл до следующего открытия хранилища.
    drop(vault);
    fs::write(&note, original)?;
    let reopened = VaultFiles::open(root.path())?;

    // Assert: повторная уборка не воспроизводит запись из журнала.
    assert_eq!(reopened.read(R2_NOTE)?.bytes, original);
    assert!(reopened.recovery_problems().is_empty());
    assert!(!finished.exists());
    Ok(())
}
