use vault_read::link_spans;

#[test]
fn link_spans_keeps_first_definition_for_repeated_reference_label()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange: две цели одной метки, употребление перед определениями.
    let source = "[read][file]\n\n[file]: first.md\n[file]: second.md\n";

    // Act: извлекаем диапазоны назначений.
    let links = link_spans(source)?;

    // Assert: CommonMark связывает употребление с первым определением.
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].link.target, "first.md");
    Ok(())
}

#[test]
fn link_spans_keeps_positions_and_counts_around_excluded_ranges()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange: экранирование, inline-код и ограждённый блок вокруг валидных ссылок.
    let source =
        "\\[[escaped]] `[[inline]]`\n\n```\n[[fenced]]\n```\n\n[[Two#intro|Two]] [two](Two.md#x)\n";
    let units: Vec<_> = source.encode_utf16().collect();

    // Act: извлекаем диапазоны назначений.
    let links = link_spans(source)?;

    // Assert: скрытые цели исключены, число и позиции ссылок прежние.
    let raw = links
        .iter()
        .map(|span| {
            let range = units
                .get(span.start.0..span.end.0)
                .ok_or("некорректный диапазон ссылки")?;
            Ok(String::from_utf16(range)?)
        })
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    assert_eq!(raw, ["Two#intro", "Two.md#x"]);
    let full = links
        .iter()
        .map(|span| {
            let range = units
                .get(span.full_start.0..span.full_end.0)
                .ok_or("некорректный полный диапазон ссылки")?;
            Ok(String::from_utf16(range)?)
        })
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    assert_eq!(full, ["[[Two#intro|Two]]", "[two](Two.md#x)"]);
    Ok(())
}
