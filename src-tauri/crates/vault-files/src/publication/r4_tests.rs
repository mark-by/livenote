use std::{fs, os::unix::fs::MetadataExt};

use tempfile::tempdir;

use super::{Mode, Publication};
use crate::{FileWrite, RelativePath, VaultFiles};

#[test]
fn interrupted_receipt_publication_recovers_original_staged_inode()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange: активируем журнал с подготовленными заметкой и квитанцией.
    let root = tempdir()?;
    let path = RelativePath::new("Receipt.md")?;
    let receipt = RelativePath::new(".livenote/requests/r4.json")?;
    let note = root.path().join(path.as_str());
    let receipt_file = root.path().join(receipt.as_str());
    fs::write(&note, b"old")?;
    let vault = VaultFiles::open(root.path())?;
    let writes = [
        FileWrite {
            path,
            expected: Some(b"old"),
            source: Some(b"updated"),
        },
        FileWrite {
            path: receipt,
            expected: None,
            source: Some(b"saved response"),
        },
    ];
    let mut journal = vault.plan(&writes, &[], None)?;
    journal.preserve_staged = true;
    journal.persist(&vault.disk)?;
    let first_stage = journal.entry("new-0")?;
    let staged = fs::metadata(root.path().join(first_stage.as_str()))?;
    let first_change = journal
        .changes
        .first()
        .ok_or("Журнал не содержит запись заметки")?;

    // Act: прерываем публикацию до записи квитанции, откатываем заметку и открываем хранилище.
    let mut publication = Publication::new(&vault.disk, &journal);
    publication.publish_file(0, first_change, Mode::Commit)?;
    publication.rollback()?;
    assert_eq!(fs::read(&note)?, b"old");
    assert!(!receipt_file.try_exists()?);
    drop(vault);
    let reopened = VaultFiles::open(root.path())?;

    // Assert: восстановление публикует квитанцию вместе с тем же inode заметки.
    assert!(reopened.recovery_problems().is_empty());
    assert_eq!(fs::read(&receipt_file)?, b"saved response");
    assert_eq!(fs::read(&note)?, b"updated");
    let recovered = fs::metadata(&note)?;
    assert_eq!(recovered.ino(), staged.ino());
    assert_eq!(recovered.modified()?, staged.modified()?);
    assert_eq!(recovered.created().ok(), staged.created().ok());
    eprintln!(
        "recovery: staged inode={} -> published inode={}; mtime={:?}",
        staged.ino(),
        recovered.ino(),
        recovered.modified()?
    );
    Ok(())
}
