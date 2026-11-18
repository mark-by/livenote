use anyhow::{Context, Result, ensure};
use std::{
    io::{Read, Seek},
    path::{Component, Path},
};
use zip::ZipArchive;

pub fn extract(input: impl Read + Seek, staging: &Path, archive_dir: &str) -> Result<()> {
    let mut archive =
        ZipArchive::new(input).context("Не удалось открыть ZIP Chrome Headless Shell")?;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .context("Не удалось прочитать запись ZIP")?;
        let path = entry.enclosed_name().context("Недопустимый путь в ZIP")?;
        let mut parts = path.components();
        let root = Some(Component::Normal(archive_dir.as_ref()));
        ensure!(
            parts.next() == root && parts.all(|part| matches!(part, Component::Normal(_))),
            "Путь в ZIP выходит за пределы каталога браузера: {}",
            path.display()
        );

        // Оба закреплённых архива содержат только обычные файлы.
        if let Some(mode) = entry.unix_mode() {
            let file_type = if entry.is_dir() { 0o040_000 } else { 0o100_000 };
            ensure!(
                mode & 0o170_000 == file_type && mode & 0o7000 == 0,
                "Недопустимый тип или права файла в ZIP: {}",
                path.display()
            );
        }
    }
    archive
        .extract(staging)
        .context("Не удалось распаковать Chrome Headless Shell")
}

#[cfg(test)]
mod tests {
    use super::extract;
    use anyhow::Result;
    use std::io::{Cursor, Write};
    use zip::{ZipWriter, write::SimpleFileOptions};

    #[test]
    fn leaves_staging_empty_when_entry_escapes_browser_directory() -> Result<()> {
        // Arrange: после допустимого файла следует путь за пределы каталога браузера.
        let root = "chrome-headless-shell-linux64";
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(
            format!("{root}/chrome-headless-shell"),
            SimpleFileOptions::default(),
        )?;
        zip.write_all(b"browser")?;
        zip.start_file(
            format!("{root}/../unexpected"),
            SimpleFileOptions::default(),
        )?;
        zip.write_all(b"unexpected bytes")?;
        let mut input = zip.finish()?;
        input.set_position(0);
        let staging = tempfile::tempdir()?;

        // Act: распаковка должна сперва проверить все записи.
        let result = extract(input, staging.path(), root);

        // Assert: архив отклонён до записи любого файла.
        assert!(result.is_err());
        assert_eq!(staging.path().read_dir()?.count(), 0);
        Ok(())
    }
}
