use std::time::{Duration, UNIX_EPOCH};

use vault_read::{
    AssetRead, BlockType, DocumentInput, FileFailure, FileTimes, ParsedDocument, ProblemCode,
    Utf16Offset, link_spans, parse_document, vault_id_for_root,
};

const PATH: &str = "Folder/One.md";
const SOURCE: &str = concat!(
    "\u{feff}---\r\naliases: [Uno]\r\ntags: [work]\r\n---\r\n\r\n🧭 #тег/два\r\n\r\n",
    "~~~~mermaid\r\nA-->B 🧭\r\n~~~~\r\n\r\n",
    "![[../Map.drawio|Map]] ![asset][ref] [[Uno#x|Here]]\r\n\r\n",
    "[ref]: <../Flow.mmd> \"title\"\r\n",
);

fn absent(path: &str) -> Result<AssetRead, FileFailure> {
    Err(FileFailure {
        code: ProblemCode::MissingAsset,
        message: path.to_owned(),
    })
}

#[test]
fn document_matches_typescript_wire_format_for_crlf_and_embeds()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange: исходник с BOM, Unicode, встроенным Mermaid и двумя файлами диаграмм.
    let input = DocumentInput {
        path: PATH,
        source: SOURCE,
        times: FileTimes {
            created: Some(UNIX_EPOCH + Duration::from_secs(1)),
            modified: UNIX_EPOCH + Duration::from_millis(1200),
        },
    };

    // Act: разбираем документ через публичный API.
    let result = ParsedDocument::parse(input, |path| {
        Ok(AssetRead {
            source: match path {
                "Map.drawio" => "<xml/>\r\n",
                "Flow.mmd" => "flowchart LR",
                other => return absent(other),
            }
            .to_owned(),
            modified: UNIX_EPOCH + Duration::from_millis(1800),
            version: None,
        })
    })?;

    // Assert: исходник, диапазоны и идентификаторы совпадают с эталоном TypeScript.
    let doc = result.document();
    assert_eq!(doc.source.as_bytes(), SOURCE.as_bytes());
    assert_eq!(doc.page.id, PATH);
    assert_eq!(doc.page.title, "One");
    assert_eq!(doc.aliases, ["Uno"]);
    assert_eq!(doc.tags, ["work", "тег/два"]);
    assert_eq!(
        doc.version,
        "sha256:52e4b77ebce07635117c51093d4b5b43ce265f33162ef4d50ab0a02d504dcf2a"
    );
    assert_eq!(doc.page.revision, 1_458_276_552_920_584);
    assert_eq!(doc.page.created_at, "1970-01-01T00:00:01.000Z");
    assert_eq!(doc.page.updated_at, "1970-01-01T00:00:01.800Z");
    assert_eq!(result.newline(), "\r\n");
    assert_eq!(
        result.prose(),
        "\naliases: [Uno]\r\ntags: [work]\n🧭 #тег/два\n\n!Map  Here\n"
    );
    let spans = result
        .spans()
        .iter()
        .filter(|span| span.kind != BlockType::Markdown)
        .map(|span| {
            (
                span.id.as_str(),
                span.start.0,
                span.end.0,
                span.content_start.0,
                span.content_end.0,
                span.destination_start.map(|at| at.0),
                span.destination_end.map(|at| at.0),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        spans,
        [
            ("span-1", 58, 85, 71, 79, None, None),
            ("span-3", 89, 111, 89, 111, Some(92), Some(105)),
            ("span-5", 112, 125, 112, 125, Some(152), Some(163)),
        ]
    );
    assert_eq!(
        doc.page
            .blocks
            .iter()
            .filter(|block| block.kind != BlockType::Markdown)
            .map(|block| block.source.as_str())
            .collect::<Vec<_>>(),
        ["A-->B 🧭", "<xml/>\r\n", "flowchart LR"],
    );
    let json = serde_json::to_value(&result)?;
    assert_eq!(
        json.pointer("/spans/3/assetPath")
            .and_then(serde_json::Value::as_str),
        Some("Map.drawio")
    );
    assert_eq!(
        json.pointer("/spans/1/sourceFrom")
            .and_then(serde_json::Value::as_u64),
        Some(71)
    );
    assert!(json.pointer("/spans/1/assetPath").is_none());
    assert_eq!(
        json.pointer("/page/blocks/1/renderOk"),
        Some(&serde_json::Value::Null)
    );
    Ok(())
}

#[test]
fn link_ranges_skip_code_and_keep_one_used_reference() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange: ссылка в коде, экранированная wiki и два употребления одного определения.
    let source = "\\[[escaped]] `[[inline]]`\n\n[[Two#intro|Two]] [two](Two.md#x) [a][ref] [b][ref]\n\n[ref]: <Two.md#ref> \"title\"\n";
    let units: Vec<_> = source.encode_utf16().collect();

    // Act: извлекаем диапазоны назначений.
    let links = link_spans(source)?;

    // Assert: код и экранированные скобки исключены; определение встречается один раз.
    let raw = links
        .iter()
        .map(|span| {
            let range = units
                .get(span.start.0..span.end.0)
                .ok_or("некорректный диапазон ссылки")?;
            Ok(String::from_utf16(range)?)
        })
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    assert_eq!(raw, ["Two#intro", "Two.md#x", "Two.md#ref"]);
    Ok(())
}

#[test]
fn standalone_formats_keep_one_source_span() -> Result<(), Box<dyn std::error::Error>> {
    let source = "\u{feff}source 🧭\r\nno final newline";
    for (path, expected) in [
        ("Flow.MERMAID", BlockType::Mermaid),
        ("Process.bpmn", BlockType::Bpmn),
        ("Architecture.drawio", BlockType::Drawio),
    ] {
        let document = parse_document(path, source, absent)?;
        let blocks = document
            .document()
            .page
            .blocks
            .iter()
            .map(|block| (block.kind, block.source.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(blocks, [(expected, source)]);
        assert_eq!(
            document
                .spans()
                .iter()
                .map(|span| (span.start, span.end))
                .collect::<Vec<_>>(),
            [(Utf16Offset(0), Utf16Offset(28))]
        );
        assert!(document.document().assets.is_empty());
    }
    Ok(())
}

#[test]
fn missing_asset_deduplicates_problems_and_ignores_remote_embed()
-> Result<(), Box<dyn std::error::Error>> {
    let source = "![missing](Absent.bpmn) ![[Absent.bpmn]]\n![remote](https://host/A.drawio)";
    let mut loaded = Vec::new();
    let parsed = parse_document(PATH, source, |path| {
        loaded.push(path.to_owned());
        absent(path)
    })?;
    assert_eq!(loaded, ["Folder/Absent.bpmn"]);
    assert_eq!(
        parsed
            .problems()
            .iter()
            .map(|problem| (problem.code, problem.block_id.as_deref()))
            .collect::<Vec<_>>(),
        [(ProblemCode::MissingAsset, Some("span-0"))]
    );
    assert_eq!(
        parsed
            .document()
            .assets
            .iter()
            .map(|asset| (asset.source.as_deref(), asset.version.as_deref()))
            .collect::<Vec<_>>(),
        [(None, None)]
    );
    Ok(())
}

#[test]
fn vault_uuid_matches_typescript_for_canonical_root() {
    assert_eq!(
        vault_id_for_root("/tmp/тест Vault"),
        "cf658f3e-8673-8af8-9d68-5f44591248cc"
    );
}

#[test]
fn frontmatter_uses_yaml_core_strings_without_expanding_collection_aliases()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange: псевдоним всей последовательности, скаляры Core и ссылка на строку.
    let source = "---\nsequence: &list [one]\naliases: *list\ntags: [foo, 0b1, 0o1, 0x1, 10000000000000000000000000000, !custom 2, &x hi, *x]\n---\n";
    let duplicate = "---\ntags: [keep]\nignored: {id: 1, id: 2}\n---\n";

    // Act: извлекаем только метаданные документа.
    let result = parse_document(PATH, source, absent)?;
    let malformed = parse_document(PATH, duplicate, absent)?;

    // Assert: теги сохраняют тип строки, а повторный ключ отменяет метаданные.
    assert!(result.document().aliases.is_empty());
    assert_eq!(result.document().tags, ["foo", "0b1", "2", "hi"]);
    assert!(malformed.document().tags.is_empty());
    Ok(())
}

#[test]
fn complete_git_conflict_is_quarantined_with_its_path() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange: проверяем полную группу маркеров и допустимый заголовок setext.
    let source = "<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> branch\r\n";

    // Act: читаем исходный текст.
    let result = parse_document(PATH, source, absent);

    // Assert: конфликт связан с заметкой, а разделитель сам по себе допустим.
    let problem = result.err().ok_or("парсер пропустил конфликт")?;
    assert_eq!(problem.code, ProblemCode::GitConflict);
    assert_eq!(problem.page_id.as_deref(), Some(PATH));
    assert_eq!(
        parse_document(PATH, "Title\n=======\n", absent)?.source(),
        "Title\n=======\n"
    );
    Ok(())
}
