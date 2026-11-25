mod github;
mod gitlab;

use std::collections::{HashSet, VecDeque};

use super::{Cite, ConnectionError, Lines, Location, Result, ScopedRepo, Session, code_cite};
use crate::agent_connections::{RepoProvider, repo::file_path};

const SCAN_FILES: usize = 40;
const SCAN_PAGES: usize = 12;
const SCAN_LINES: usize = 200;

struct Entry {
    path: String,
    directory: bool,
}

pub(super) async fn search(
    session: &mut Session,
    repo: ScopedRepo,
    query: &str,
    limit: usize,
) -> Result<Vec<(Location, Cite, String)>> {
    let sha = match repo.kind {
        RepoProvider::Github => github::commit(session, &repo).await?,
        RepoProvider::Gitlab => gitlab::commit(session, &repo).await?,
    };
    match repo.kind {
        RepoProvider::Github if session.supports("search_code") => {
            return github::search(session, &repo, &sha, query, limit).await;
        }
        RepoProvider::Gitlab if session.supports("search_project_code") => {
            return gitlab::search(session, &repo, &sha, query, limit).await;
        }
        _ => {}
    }
    let entries = match repo.kind {
        RepoProvider::Github => github::files(session, &repo, &sha).await?,
        RepoProvider::Gitlab => gitlab::files(session, &repo, &sha).await?,
    };
    let query = query.to_lowercase();
    let mut hits = Vec::new();
    let mut seen = HashSet::new();
    for path in entries
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .take(SCAN_FILES)
    {
        let lines = Lines {
            first: 1,
            last: SCAN_LINES,
        };
        let text = match read(session, &repo, &sha, &path, lines).await {
            Ok(text) => text,
            Err(ConnectionError::Scope) => continue,
            Err(error) => return Err(error),
        };
        for (index, line) in text.lines().enumerate() {
            if !line.to_lowercase().contains(&query) {
                continue;
            }
            let cite = code_cite(&repo, &sha, &path, index + 1)?;
            let location = Location::File {
                repo: repo.clone(),
                sha: sha.clone(),
                path: path.clone(),
            };
            hits.push((location, cite, line.chars().take(800).collect()));
            if hits.len() == limit {
                return Ok(hits);
            }
        }
    }
    Ok(hits)
}

pub(super) async fn read(
    session: &mut Session,
    repo: &ScopedRepo,
    sha: &str,
    path: &str,
    lines: Lines,
) -> Result<String> {
    match repo.kind {
        RepoProvider::Github => github::read(session, repo, sha, path, lines).await,
        RepoProvider::Gitlab => gitlab::read(session, repo, sha, path, lines).await,
    }
}

fn push_entries(entries: Vec<Entry>, dirs: &mut VecDeque<String>, files: &mut Vec<String>) {
    for entry in entries {
        if !file_path(&entry.path) {
            continue;
        }
        if entry.directory {
            dirs.push_back(entry.path);
        } else {
            files.push(entry.path);
        }
    }
}
