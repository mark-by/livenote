use std::{cell::Cell, collections::HashMap, fs};

use rusqlite::Connection;
use vault_read::{
    FileBytes, FileFailure, FileTimes, ProblemCode, StagedFile, VaultIndex, VaultProjection,
    VaultReadSource, VaultScan, file_version,
};

const NOTE: &str = "Folder/Note.md";
const ASSET: &str = "Hidden/Map.drawio";
const TARGET: &str = "Other.md";
const SOURCE: &str =
    "\u{feff}[[Alias#x|Видимый]] [[Alias]] ![[../Hidden/Map.drawio]]\r\n\r\n#тег `ignored`";
const TARGET_SOURCE: &str = "---\naliases: [Alias]\ntags: [тег]\n---\n\nBody";

#[derive(Default)]
struct Files<'a> {
    contents: HashMap<&'a str, (&'a [u8], &'a str)>,
    reads: Cell<usize>,
}

impl VaultReadSource for Files<'_> {
    fn stamp(&self, path: &str) -> Result<String, FileFailure> {
        self.contents
            .get(path)
            .map(|&(_, stamp)| stamp.to_owned())
            .ok_or(FileFailure {
                code: ProblemCode::MissingAsset,
                message: "Файл не найден".to_owned(),
            })
    }

    fn read_bytes(&self, path: &str) -> Result<FileBytes, FileFailure> {
        let stamp = self.stamp(path)?;
        self.reads.set(self.reads.get() + 1);
        let (bytes, _) = self.contents.get(path).ok_or(FileFailure {
            code: ProblemCode::MissingAsset,
            message: "Файл не найден".to_owned(),
        })?;
        Ok(FileBytes {
            bytes: bytes.to_vec(),
            stamp,
            times: FileTimes::default(),
        })
    }
}

#[test]
fn projection_links_use_aliases_without_indexing_hidden_assets()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange: две заметки и диаграмма в скрытой папке.
    let files = Files {
        contents: HashMap::from([
            (NOTE, (SOURCE.as_bytes(), "note")),
            (TARGET, (TARGET_SOURCE.as_bytes(), "other")),
            (ASSET, (b"<mxfile/>\r\n".as_slice(), "map")),
        ]),
        ..Files::default()
    };
    let paths = [TARGET.to_owned(), NOTE.to_owned()];
    let folders = [String::new(), "Folder".to_owned()];
    let hidden = ["Hidden".to_owned()];
    let scan = VaultScan {
        files: &paths,
        folders: &folders,
        ignored_folders: &hidden,
        ..VaultScan::default()
    };
    let mut projection = VaultProjection::new();

    // Act: применяем проверенное сканирование.
    projection.reconcile(scan, &files);

    // Assert: заметка находит скрытую диаграмму, а цель получает одну обратную ссылку.
    let note = projection
        .document(NOTE)
        .ok_or("пропала заметка")?
        .document();
    let target = projection
        .document(TARGET)
        .ok_or("пропала цель")?
        .document();
    assert_eq!(note.source.as_bytes(), SOURCE.as_bytes());
    assert_eq!(
        note.links
            .iter()
            .map(|link| link.target_page_id.as_deref())
            .collect::<Vec<_>>(),
        [Some(TARGET), Some(TARGET), None]
    );
    assert_eq!(
        target
            .backlinks
            .iter()
            .map(|backlink| backlink.page_id.as_str())
            .collect::<Vec<_>>(),
        [NOTE]
    );
    assert_eq!(
        note.assets
            .iter()
            .map(|asset| (asset.path.as_str(), asset.source.as_deref()))
            .collect::<Vec<_>>(),
        [(ASSET, Some("<mxfile/>\r\n"))]
    );
    let snapshot = projection.snapshot(Some("Fixture"));
    assert_eq!(
        snapshot
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        [NOTE, TARGET]
    );
    assert_eq!(
        snapshot
            .tags
            .iter()
            .map(|tag| (tag.tag.as_str(), tag.count))
            .collect::<Vec<_>>(),
        [("тег", 2)]
    );
    assert_eq!(snapshot.folders, ["", "Folder"]);
    assert_eq!(
        snapshot.tree_version,
        file_version(
            format!(
                r#"[["","Folder"],[["{NOTE}","{}"],["{TARGET}","{}"]]]"#,
                file_version(SOURCE.as_bytes()),
                file_version(TARGET_SOURCE.as_bytes()),
            )
            .as_bytes()
        )
    );
    Ok(())
}

#[test]
fn search_uses_markdown_prose_and_all_folded_query_words() -> Result<(), Box<dyn std::error::Error>>
{
    // Arrange: цель с псевдонимом, заголовком и видимым текстом в разных полях.
    let files = Files {
        contents: HashMap::from([
            (NOTE, (SOURCE.as_bytes(), "note")),
            (TARGET, (TARGET_SOURCE.as_bytes(), "other")),
        ]),
        ..Files::default()
    };
    let paths = [TARGET.to_owned(), NOTE.to_owned()];
    let mut projection = VaultProjection::new();
    projection.reconcile(
        VaultScan {
            files: &paths,
            ..VaultScan::default()
        },
        &files,
    );

    // Act: ищем несколько слов без учёта регистра и с точным тегом.
    let hits = projection.search("ALIAS bOdY\u{feff}", Some("тег"))?;

    // Assert: поиск находит цель и отдаёт текст Markdown.
    let hits = hits
        .iter()
        .map(|hit| (hit.path.as_str(), hit.excerpt.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(hits, [(TARGET, " aliases: [Alias] tags: [тег] Body")]);
    Ok(())
}

#[test]
fn sqlite_reuses_confirmed_records_and_excludes_staged_bytes()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange: создаём кэш с подтверждённым текстом заметки.
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("vault");
    fs::create_dir(&root)?;
    let root = root.canonicalize()?;
    let root = root.to_str().ok_or("путь проверки не UTF-8")?;
    let cache = temp.path().join("cache");
    let paths = [TARGET.to_owned()];
    let scan = VaultScan {
        files: &paths,
        ..VaultScan::default()
    };
    let files = Files {
        contents: HashMap::from([(TARGET, (TARGET_SOURCE.as_bytes(), "other"))]),
        ..Files::default()
    };
    let mut cold = VaultProjection::with_index(VaultIndex::new(&cache, root));
    cold.reconcile(scan, &files);
    let mut staged = cold;
    let write = StagedFile {
        path: TARGET,
        source: Some(b"Draft"),
    };
    staged.reconcile_staged(scan, &files, &[write]);
    assert_eq!(
        staged.document(TARGET).ok_or("пропал черновик")?.source(),
        "Draft"
    );
    files.reads.set(0);

    // Act: открываем кэш снова после отмены подготовленной правки.
    let mut warm = VaultProjection::with_index(VaultIndex::new(&cache, root));
    warm.reconcile(scan, &files);

    // Assert: кэш даёт подтверждённый документ без повторного чтения.
    assert_eq!(files.reads.get(), 0);
    assert_eq!(
        warm.document(TARGET).ok_or("пропала заметка")?.source(),
        TARGET_SOURCE
    );
    Ok(())
}

#[test]
fn sqlite_recovers_corrupt_payload_at_its_system_path() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange: повреждаем полезную нагрузку индекса, сохраняя старую контрольную сумму.
    let temp = tempfile::tempdir()?;
    let root_path = temp.path().join("vault");
    fs::create_dir(&root_path)?;
    let root_path = root_path.canonicalize()?;
    let root = root_path.to_str().ok_or("путь проверки не UTF-8")?;
    let cache = temp.path().join("cache");
    let paths = [TARGET.to_owned()];
    let scan = VaultScan {
        files: &paths,
        ..VaultScan::default()
    };
    let files = Files {
        contents: HashMap::from([(TARGET, (TARGET_SOURCE.as_bytes(), "other"))]),
        ..Files::default()
    };
    let index = VaultIndex::new(&cache, root);
    let location = index.path().to_path_buf();
    VaultProjection::with_index(index).reconcile(scan, &files);
    Connection::open(&location)?.execute(
        "UPDATE files SET payload = json_set(payload, '$.text.source', 'подменённый текст')",
        [],
    )?;
    files.reads.set(0);

    // Act: сверяем сканирование с повреждённым кэшем.
    let mut projection = VaultProjection::with_index(VaultIndex::new(&cache, root));
    projection.reconcile(scan, &files);

    // Assert: проекция использует подтверждённые байты и записывает новую полезную нагрузку.
    assert_eq!(files.reads.get(), 1);
    assert_eq!(
        projection
            .document(TARGET)
            .ok_or("пропала заметка")?
            .source(),
        TARGET_SOURCE
    );
    let payload: String =
        Connection::open(location)?.query_row("SELECT payload FROM files", [], |row| row.get(0))?;
    let payload: serde_json::Value = serde_json::from_str(&payload)?;
    assert_eq!(
        payload
            .pointer("/text/source")
            .and_then(serde_json::Value::as_str),
        Some(TARGET_SOURCE)
    );
    Ok(())
}
