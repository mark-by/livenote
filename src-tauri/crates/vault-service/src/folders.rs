use crate::{
    ApiError,
    state::{State, user_path},
    transaction::{Change, Plan},
    tree::child,
};
use vault_files::DirectoryChange;
use vault_read::VaultSnapshot;
impl State {
    pub(crate) fn create_folder(
        &mut self,
        path: &str,
        version: &str,
    ) -> Result<VaultSnapshot, ApiError> {
        self.check_tree(version)?;
        self.destination(path, None)?;
        let directory = DirectoryChange {
            path: user_path(path)?,
            old: false,
            next: true,
        };
        self.commit(
            &Plan {
                directories: vec![directory],
                ..Plan::default()
            },
            "",
        )?;
        self.emit("vault.updated", "", 0);
        Ok(self.snapshot())
    }

    pub(crate) fn delete_folder(
        &mut self,
        path: &str,
        version: &str,
        recursive: bool,
    ) -> Result<VaultSnapshot, ApiError> {
        self.check_tree(version)?;
        user_path(path)?;
        self.folder_safe(path)?;
        let mut plan = Plan::default();
        for file in self.listing.files.iter().filter(|file| child(file, path)) {
            if !recursive {
                return Err(ApiError::destination(path, "Папка не пуста"));
            }
            plan.writes
                .push(Change::new(file, Some(self.files.read(file)?.bytes), None)?);
        }
        for folder in self
            .listing
            .folders
            .iter()
            .filter(|folder| *folder == path || child(folder, path))
        {
            if !recursive && folder != path {
                return Err(ApiError::destination(path, "Папка не пуста"));
            }
            plan.directories.push(DirectoryChange {
                path: user_path(folder)?,
                old: true,
                next: false,
            });
        }
        let before = self.revisions();
        self.commit(&plan, "")?;
        self.emit("vault.updated", "", 0);
        for (file, revision) in &before {
            if child(file, path) {
                self.emit("page.deleted", file, *revision);
            }
        }
        self.related(&before, "");
        Ok(self.snapshot())
    }

    pub(crate) fn folder_safe(&self, path: &str) -> Result<(), ApiError> {
        if !self.listing.folders.iter().any(|folder| folder == path) {
            return Err(ApiError::not_found("Папка не найдена"));
        }
        if self
            .listing
            .hidden_entries
            .iter()
            .any(|entry| child(entry, path))
            || self
                .listing
                .problems
                .iter()
                .any(|problem| problem.path == path || child(&problem.path, path))
        {
            return Err(ApiError::invalid(
                "Папка содержит скрытые или небезопасные пути",
            ));
        }
        Ok(())
    }
}
