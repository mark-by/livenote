use crate::{ApiError, source::problem, state::State};
use serde_json::json;
use std::io::{Cursor, Write};
impl State {
    pub(crate) fn export_archive(&self) -> Result<Vec<u8>, ApiError> {
        if !self.listing.problems.is_empty() {
            let problems = self
                .listing
                .problems
                .iter()
                .map(problem)
                .collect::<Vec<_>>();
            return Err(ApiError::invalid("Небезопасный файл в экспорте").details(json!(problems)));
        }
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for folder in self.listing.folders.iter().filter(|path| !path.is_empty()) {
            zip.add_directory(format!("{folder}/"), options)
                .map_err(ApiError::internal)?;
        }
        for path in &self.listing.files {
            zip.start_file(path, options).map_err(ApiError::internal)?;
            zip.write_all(&self.files.read(path)?.bytes)
                .map_err(ApiError::internal)?;
        }
        Ok(zip.finish().map_err(ApiError::internal)?.into_inner())
    }
}
