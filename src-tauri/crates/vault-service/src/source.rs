use vault_files::{
    VaultFileError, VaultFileProblem, VaultFileProblemCode, VaultFiles, VaultListing,
};
use vault_read::{
    AssetRead, FileBytes, FileFailure, FileTimes, ProblemCode, VaultProblem, VaultReadSource,
    VaultScan,
};
pub fn problem(p: &VaultFileProblem) -> VaultProblem {
    let code = match p.code {
        VaultFileProblemCode::UnsafePath => ProblemCode::UnsafePath,
        VaultFileProblemCode::UnreadableFile => ProblemCode::UnreadableFile,
    };
    VaultProblem {
        path: p.path.clone(),
        message: p.message.clone(),
        code,
        page_id: None,
        block_id: None,
    }
}

pub fn scan<'a>(
    listing: &'a VaultListing,
    problems: (&'a [VaultProblem], &'a [VaultProblem]),
) -> VaultScan<'a> {
    VaultScan {
        files: &listing.files,
        folders: &listing.folders,
        problems: problems.0,
        recovery_problems: problems.1,
        ignored_folders: &listing.ignored_folders,
    }
}

pub struct Source<'a>(pub(crate) &'a VaultFiles);

fn failure(error: &VaultFileError) -> FileFailure {
    let code = match error {
        VaultFileError::UnsafePath { .. } => ProblemCode::UnsafePath,
        VaultFileError::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound => {
            ProblemCode::MissingAsset
        }
        _ => ProblemCode::UnreadableFile,
    };
    FileFailure {
        code,
        message: error.to_string(),
    }
}

impl VaultReadSource for Source<'_> {
    fn stamp(&self, path: &str) -> Result<String, FileFailure> {
        self.0.stamp(path).map_err(|error| failure(&error))
    }

    fn read_bytes(&self, path: &str) -> Result<FileBytes, FileFailure> {
        let file = self.0.read(path).map_err(|error| failure(&error))?;
        let times = FileTimes {
            created: file.created,
            modified: file.modified,
        };
        Ok(FileBytes {
            bytes: file.bytes,
            stamp: file.stamp,
            times,
        })
    }
}

impl Source<'_> {
    pub(crate) fn asset(&self, path: &str) -> Result<AssetRead, FileFailure> {
        let file = self.read_bytes(path)?;
        let version = vault_read::file_version(&file.bytes);
        let source = String::from_utf8(file.bytes).map_err(|error| FileFailure {
            code: ProblemCode::UnreadableFile,
            message: error.to_string(),
        })?;
        Ok(AssetRead {
            source,
            version: Some(version),
            modified: file.times.modified,
        })
    }
}
