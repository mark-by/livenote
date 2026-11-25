use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::Command;

use tempfile::tempdir;
use vault_files::{
    DirectoryChange, FileWrite, PathRename, RelativePath, VaultFileError, VaultFiles,
};

type Result = std::result::Result<(), Box<dyn std::error::Error>>;

fn write<'a>(
    path: &str,
    expected: Option<&'a [u8]>,
    source: Option<&'a [u8]>,
) -> std::result::Result<FileWrite<'a>, VaultFileError> {
    Ok(FileWrite {
        path: RelativePath::new(path)?,
        expected,
        source,
    })
}

fn node_journal(root: &Path, id: &str, path: &str) -> std::io::Result<()> {
    let dir = root.join(".livenote/transactions").join(id);
    fs::create_dir_all(&dir)?;
    fs::write(
        dir.join("journal.json"),
        format!(
            concat!(
                "{{\"id\":\"{}\",\"changes\":[{{\"path\":\"{}\",\"old\":\"b2xk\",\"next\":\"bmV3\",",
                "\"oldHash\":\"cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4\",",
                "\"newHash\":\"11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437\"}}]}}"
            ),
            id, path
        ),
    )
}

#[test]
fn refuses_symlinks_and_replaced_root() -> Result {
    // Arrange: ссылки ведут в другой временный каталог.
    let parent = tempdir()?;
    let outside = tempdir()?;
    let root = parent.path().join("vault");
    fs::write(outside.path().join("Note.md"), b"outside")?;
    fs::create_dir(&root)?;
    symlink(outside.path(), root.join("link"))?;
    symlink(&root, parent.path().join("alias"))?;

    // Act: открываем хранилище и читаем через ссылки.
    let alias = VaultFiles::open(&parent.path().join("alias/."));
    let vault = VaultFiles::open(&root)?;
    let linked = vault.read("link/Note.md");
    fs::rename(&root, parent.path().join("former"))?;
    fs::create_dir(&root)?;
    let replaced = vault.list();

    // Assert: файловая граница отклоняет каждый небезопасный путь.
    assert!(matches!(alias, Err(VaultFileError::UnsafePath { .. })));
    assert!(matches!(linked, Err(VaultFileError::UnsafePath { .. })));
    assert!(matches!(replaced, Err(VaultFileError::UnsafePath { .. })));
    Ok(())
}

#[test]
fn lists_literal_ignore_rules_but_preserves_git_rules_and_hidden_read() -> Result {
    // Arrange: Git и LiveNote получают разные правила.
    let root = tempdir()?;
    fs::create_dir(root.path().join("star*"))?;
    fs::create_dir(root.path().join("starfish"))?;
    fs::write(
        root.path().join(".livenoteignore"),
        "\u{feff}# comment\r\n /star*/ \r\nfile.md\n",
    )?;
    let git_rules = b"starfish/\n";
    fs::write(root.path().join(".gitignore"), git_rules)?;
    fs::write(root.path().join("file.md"), b"file")?;
    fs::write(root.path().join("star*/Map.drawio"), b"hidden asset")?;
    fs::write(root.path().join("starfish/Visible.md"), b"visible")?;

    // Act: строим список файлов через Rust.
    let vault = VaultFiles::open(root.path())?;
    let list = vault.list()?;

    // Assert: правило скрывает каталог, а вложение остаётся доступным.
    assert_eq!(list.files, [".gitignore", "file.md", "starfish/Visible.md"]);
    assert_eq!(list.ignored_folders, ["star*"]);
    assert_eq!(vault.read("star*/Map.drawio")?.bytes, b"hidden asset");
    assert_eq!(fs::read(root.path().join(".gitignore"))?, git_rules);
    assert_eq!(fs::read(root.path().join(".livenote/.gitignore"))?, b"*\n");
    Ok(())
}

#[test]
fn respects_live_node_lock_and_reclaims_dead_pid() -> Result {
    // Arrange: используем PID процесса, которым управляет тест.
    let root = tempdir()?;
    let lock = root.path().join(".livenote/lock");
    fs::create_dir(root.path().join(".livenote"))?;
    let mut holder = Command::new("/bin/sleep").arg("60").spawn()?;
    let node_identity = format!("{{\"pid\":{},\"nonce\":\"legacy\"}}", holder.id());
    let prepared = fs::write(&lock, &node_identity);
    let live = VaultFiles::open(root.path());
    holder.kill()?;
    holder.wait()?;
    prepared?;

    // Act: повторяем открытие, когда PID больше не существует.
    let vault = VaultFiles::open(root.path())?;
    let identity: serde_json::Value = serde_json::from_slice(&fs::read(&lock)?)?;

    // Assert: живой PID заблокировал открытие, а устаревшую запись заменил Rust.
    assert!(matches!(live, Err(VaultFileError::Locked)));
    assert_eq!(identity["pid"], std::process::id());
    assert!(
        identity["nonce"]
            .as_str()
            .is_some_and(|nonce| uuid::Uuid::parse_str(nonce).is_ok())
    );
    drop(vault);
    assert!(!lock.exists());
    Ok(())
}

#[test]
fn stale_expected_bytes_prevent_any_publication() -> Result {
    // Arrange: второй файл изменил внешний редактор.
    let root = tempdir()?;
    fs::write(root.path().join("B.md"), b"edited")?;
    let mut vault = VaultFiles::open(root.path())?;
    let writes = [
        write("A.md", None, Some(b"addition"))?,
        write("B.md", Some(b"previous"), None)?,
    ];

    // Act: публикуем обе операции одним запросом.
    let result = vault.commit(&writes, &[], None);

    // Assert: конфликт не публикует ни одной записи.
    assert!(matches!(result, Err(VaultFileError::Stale { path }) if path == "B.md"));
    assert!(vault.read_optional("A.md")?.is_none());
    assert_eq!(vault.read("B.md")?.bytes, b"edited");
    Ok(())
}

#[test]
fn replays_node_journal_and_isolates_unrelated_conflict() -> Result {
    // Arrange: одна запись содержит неизвестные байты, другая готова к восстановлению.
    let root = tempdir()?;
    fs::write(root.path().join("Blocked.md"), b"external")?;
    fs::write(root.path().join("Recover.md"), b"old")?;
    node_journal(root.path(), "a-blocked", "Blocked.md")?;
    node_journal(root.path(), "b-recover", "Recover.md")?;

    // Act: открываем Rust поверх двух журналов Node.
    let vault = VaultFiles::open(root.path())?;

    // Assert: один конфликт не мешает восстановить другой файл.
    assert_eq!(vault.read("Blocked.md")?.bytes, b"external");
    assert_eq!(vault.read("Recover.md")?.bytes, b"new");
    assert_eq!(
        vault
            .recovery_problems()
            .iter()
            .map(|problem| problem.path.as_str())
            .collect::<Vec<_>>(),
        ["Blocked.md"]
    );
    assert!(
        root.path()
            .join(".livenote/transactions/a-blocked/journal.json")
            .is_file()
    );
    assert!(
        !root
            .path()
            .join(".livenote/transactions/b-recover")
            .exists()
    );
    Ok(())
}

#[test]
fn replays_interrupted_legacy_agent_undo_transaction() -> Result {
    // Arrange: прежнее Undo восстановило заметку, но ещё не удалило вложение и каталог.
    let root = tempdir()?;
    let id = "3d3c2bf4-29d0-4acc-9d70-7ead555fd88e";
    let active = root.path().join(".livenote/transactions").join(id);
    fs::create_dir_all(&active)?;
    fs::create_dir(root.path().join("Diagrams"))?;
    fs::write(root.path().join("Note.md"), b"old")?;
    fs::write(root.path().join("Diagrams/Map.drawio"), b"new")?;
    let historical = root.path().join(".livenote/undo-history");
    fs::write(&historical, b"leave unchanged")?;
    let new_hash = "11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437";
    let old_hash = "cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4";
    let legacy = serde_json::json!({
        "id": id,
        "changes": [
            {"path": "Note.md", "old": "bmV3", "next": "b2xk", "oldHash": new_hash, "newHash": old_hash},
            {"path": "Diagrams/Map.drawio", "old": "bmV3", "next": null, "oldHash": new_hash, "newHash": null}
        ],
        "directories": [{"path": "Diagrams", "old": true, "next": false}]
    });
    fs::write(active.join("journal.json"), serde_json::to_vec(&legacy)?)?;

    // Act: открываем хранилище после прерванной транзакции.
    let vault = VaultFiles::open(root.path())?;

    // Assert: журнал завершает только записанную операцию и не трогает сторонний файл.
    assert_eq!(vault.read("Note.md")?.bytes, b"old");
    assert!(!root.path().join("Diagrams").exists());
    assert!(!active.exists());
    assert!(vault.recovery_problems().is_empty());
    assert_eq!(fs::read(historical)?, b"leave unchanged");
    Ok(())
}

#[test]
fn renames_directory_case_and_preserves_binary_contents_and_empty_folder() -> Result {
    // Arrange: дерево содержит двоичный файл и пустой каталог.
    let root = tempdir()?;
    fs::create_dir_all(root.path().join("Docs/Empty/Nested"))?;
    let bytes = b"\xff\x00\n\r";
    fs::write(root.path().join("Docs/data.bin"), bytes)?;
    let mut vault = VaultFiles::open(root.path())?;
    let rename = PathRename {
        from: RelativePath::new("Docs")?,
        to: RelativePath::new("docs")?,
    };

    // Act: меняем регистр каталога через промежуточное имя.
    assert!(vault.commit(&[], &[], Some(&rename))?);

    // Assert: каталог меняет регистр даже на ФС без учёта регистра.
    let listing = vault.list()?;
    assert_eq!(
        listing.folders,
        ["", "docs", "docs/Empty", "docs/Empty/Nested"]
    );
    assert_eq!(vault.read("docs/data.bin")?.bytes, bytes);
    Ok(())
}

#[test]
fn publishes_receipt_with_new_file_and_empty_directory() -> Result {
    // Arrange: один запрос создаёт файл, квитанцию и пустой каталог.
    let root = tempdir()?;
    let mut vault = VaultFiles::open(root.path())?;
    let receipt = ".livenote/requests/result.json";
    let writes = [
        write("Docs/Note.md", None, Some(b"\xef\xbb\xbfBytes\r\n"))?,
        write(receipt, None, Some(b"{}"))?,
    ];
    let empty = DirectoryChange {
        path: RelativePath::new("Docs/Empty/Nested")?,
        old: false,
        next: true,
    };

    // Act: публикуем все изменения через журнал.
    assert!(vault.commit(&writes, &[empty], None)?);

    // Assert: список скрывает квитанцию, а чтение сохраняет точные байты.
    assert_eq!(vault.list()?.files, ["Docs/Note.md"]);
    assert!(root.path().join("Docs/Empty/Nested").is_dir());
    assert_eq!(vault.read("Docs/Note.md")?.bytes, b"\xef\xbb\xbfBytes\r\n");
    assert_eq!(vault.read(receipt)?.bytes, b"{}");
    Ok(())
}
