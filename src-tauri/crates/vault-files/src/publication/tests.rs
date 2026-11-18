use std::fs;

use rustix::fs::AtFlags;
use tempfile::tempdir;

use super::{Mode, Publication};
use crate::{FileWrite, PathRename, RelativePath, VaultFiles};

#[test]
fn failed_publication_restores_rename_and_original_bytes() -> Result<(), Box<dyn std::error::Error>>
{
    // Arrange: журнал содержит правку файла при переименовании и правку ссылки.
    let root = tempdir()?;
    fs::write(root.path().join("Note.md"), b"old")?;
    fs::write(root.path().join("Reference.md"), b"old")?;
    let vault = VaultFiles::open(root.path())?;
    let rename = PathRename {
        from: RelativePath::new("Note.md")?,
        to: RelativePath::new("note.md")?,
    };
    let writes = [
        FileWrite {
            path: rename.to.clone(),
            source: Some(b"new"),
            expected: Some(b"old"),
        },
        FileWrite {
            path: RelativePath::new("Reference.md")?,
            source: Some(b"new"),
            expected: Some(b"old"),
        },
    ];
    let journal = vault.plan(&writes, &[], Some(&rename))?;
    journal.persist(&vault.disk)?;
    // Сбой второй записи произойдёт после публикации первой.
    vault
        .disk
        .unlink(&journal.entry("new-1")?, AtFlags::empty())?;
    let mut publication = Publication::new(&vault.disk, &journal);

    // Act: выполняем публикацию и откатываем применённые действия при сбое.
    assert!(publication.apply(Mode::Commit).is_err());
    assert_eq!(vault.read("note.md")?.bytes, b"new");
    publication.rollback()?;

    // Assert: исходное имя и байты вернулись; журнал остаётся совместим с Node.
    assert_eq!(vault.list()?.files, ["Note.md", "Reference.md"]);
    assert_eq!(vault.read("Note.md")?.bytes, b"old");
    let expected_json = format!(
        concat!(
            "{{\"id\":\"{}\",\"changes\":[{{\"path\":\"note.md\",\"old\":\"b2xk\",\"next\":\"bmV3\",",
            "\"oldHash\":\"cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4\",",
            "\"newHash\":\"11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437\"}},",
            "{{\"path\":\"Reference.md\",\"old\":\"b2xk\",\"next\":\"bmV3\",",
            "\"oldHash\":\"cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4\",",
            "\"newHash\":\"11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437\"}}],",
            "\"directories\":[],\"rename\":{{\"from\":\"Note.md\",\"to\":\"note.md\"}}}}"
        ),
        journal.id
    );
    assert_eq!(
        vault.disk.read(&journal.entry("journal.json")?)?.bytes,
        expected_json.as_bytes()
    );
    Ok(())
}
