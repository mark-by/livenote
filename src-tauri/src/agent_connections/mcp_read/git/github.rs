use std::collections::{HashSet, VecDeque};

use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

use super::{
    Cite, ConnectionError, Entry, Lines, Location, Result, SCAN_FILES, SCAN_LINES, SCAN_PAGES,
    ScopedRepo, Session, code_cite, push_entries,
};
use crate::agent_connections::{mcp_read::window, mcp_wire::Content, repo, transport};

#[derive(Deserialize)]
struct Commit {
    sha: String,
    html_url: String,
}

#[derive(Deserialize)]
struct SearchResults {
    items: Vec<SearchEntry>,
}

#[derive(Deserialize)]
struct SearchEntry {
    path: String,
    html_url: String,
    repository: SearchRepository,
}

#[derive(Deserialize)]
struct SearchRepository {
    full_name: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Listing {
    Structured { directory: Vec<FileEntry> },
    Entries(Vec<FileEntry>),
}

#[derive(Deserialize)]
struct FileEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    html_url: Option<String>,
}

pub(super) async fn commit(session: &mut Session, repo: &ScopedRepo) -> Result<String> {
    let mut args = repository_args(repo)?;
    args["sha"] = json!(repo.reference);
    args["detail"] = json!("none");
    let result: Commit = session.call("get_commit", args).await?.decode()?;
    let url = transport::endpoint(&result.html_url).map_err(|_| ConnectionError::Scope)?;
    if !repo::sha(&result.sha)
        || url.origin() != repo.url.origin()
        || url.path() != repo.commit_path(&result.sha)
        || (repo::sha(&repo.reference) && repo.reference != result.sha)
    {
        return Err(ConnectionError::Scope);
    }
    Ok(result.sha)
}

pub(super) async fn search(
    session: &mut Session,
    repo: &ScopedRepo,
    sha: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<(Location, Cite, String)>> {
    let args = json!({
        "query": format!("{query} repo:{}", repo.project),
        "perPage": limit,
    });
    let result: SearchResults = session.call("search_code", args).await?.decode()?;
    let query = query.to_lowercase();
    let mut hits = Vec::new();
    for entry in result.items.into_iter().filter(|entry| {
        entry.repository.full_name == repo.project
            && repo::file_path(&entry.path)
            && search_url(repo, sha, entry).is_ok()
    }) {
        for page in 0..SCAN_PAGES {
            let first = page * SCAN_LINES + 1;
            let lines = Lines {
                first,
                last: first + SCAN_LINES - 1,
            };
            let text = match read(session, repo, sha, &entry.path, lines).await {
                Ok(text) => text,
                Err(ConnectionError::Scope) => break,
                Err(error) => return Err(error),
            };
            let Some((index, line)) = text
                .lines()
                .enumerate()
                .find(|(_, line)| line.to_lowercase().contains(&query))
            else {
                continue;
            };
            let line_number = first + index;
            let cite = code_cite(repo, sha, &entry.path, line_number)?;
            let location = Location::File {
                repo: repo.clone(),
                sha: sha.into(),
                path: entry.path.clone(),
            };
            hits.push((location, cite, line.chars().take(800).collect()));
            break;
        }
        if hits.len() == limit {
            break;
        }
    }
    Ok(hits)
}

fn search_url(repo: &ScopedRepo, sha: &str, entry: &SearchEntry) -> Result<()> {
    let mut url = transport::endpoint(&entry.html_url).map_err(|_| ConnectionError::Scope)?;
    url.set_fragment(None);
    for reference in [sha, repo.reference.as_str()] {
        let mut expected = repo.blob_url(reference, &entry.path, 1)?;
        expected.set_fragment(None);
        if url == expected {
            return Ok(());
        }
    }
    Err(ConnectionError::Scope)
}

pub(super) async fn files(
    session: &mut Session,
    repo: &ScopedRepo,
    sha: &str,
) -> Result<Vec<String>> {
    let mut files = Vec::new();
    let mut dirs = VecDeque::from([String::new()]);
    let mut seen = HashSet::new();
    for _ in 0..SCAN_PAGES {
        let Some(dir) = dirs.pop_front() else { break };
        if !seen.insert(dir.clone()) {
            continue;
        }
        let args = content_args(repo, sha, if dir.is_empty() { "/" } else { &dir })?;
        let result: Listing = session.call("get_file_contents", args).await?.decode()?;
        let entries = match result {
            Listing::Structured { directory } | Listing::Entries(directory) => directory,
        };
        let entries = entries
            .into_iter()
            .filter_map(|entry| {
                let parent = entry.path.rsplit_once('/').map_or("", |(parent, _)| parent);
                if parent != dir || !matches!(entry.kind.as_str(), "dir" | "file") {
                    return None;
                }
                if let Some(html_url) = entry.html_url {
                    let url = transport::endpoint(&html_url).ok()?;
                    let mut expected = repo.blob_url(sha, &entry.path, 1).ok()?;
                    expected.set_fragment(None);
                    if entry.kind == "dir" {
                        let prefix = format!("{}/tree/{sha}/", repo.url.path());
                        if url.origin() != expected.origin()
                            || url.path().strip_prefix(&prefix)?
                                != expected
                                    .path()
                                    .strip_prefix(&format!("{}/blob/{sha}/", repo.url.path()))?
                        {
                            return None;
                        }
                    } else if url != expected {
                        return None;
                    }
                }
                Some(Entry {
                    path: entry.path,
                    directory: entry.kind == "dir",
                })
            })
            .collect();
        push_entries(entries, &mut dirs, &mut files);
        if files.len() >= SCAN_FILES {
            break;
        }
    }
    Ok(files)
}

pub(super) async fn read(
    session: &mut Session,
    repo: &ScopedRepo,
    sha: &str,
    path: &str,
    lines: Lines,
) -> Result<String> {
    let args = content_args(repo, sha, path)?;
    let result = session.call("get_file_contents", args).await?;
    let expected = resource_uri(repo, sha, path)?;
    for entry in result.content {
        if let Content::Resource { resource } = entry {
            let uri = Url::parse(&resource.uri).map_err(|_| ConnectionError::Scope)?;
            if uri != expected {
                return Err(ConnectionError::Scope);
            }
            let text = resource.text.ok_or(ConnectionError::Scope)?;
            return window(&text, lines);
        }
    }
    // Сервер возвращает только ссылку для больших файлов и метаданные для подмодулей.
    Err(ConnectionError::Scope)
}

fn repository_args(repo: &ScopedRepo) -> Result<Value> {
    let (owner, name) = repo.project.split_once('/').ok_or(ConnectionError::Scope)?;
    Ok(json!({"owner":owner,"repo":name}))
}

fn content_args(repo: &ScopedRepo, sha: &str, path: &str) -> Result<Value> {
    let mut args = repository_args(repo)?;
    args["sha"] = json!(sha);
    args["path"] = json!(path);
    Ok(args)
}

fn resource_uri(repo: &ScopedRepo, sha: &str, path: &str) -> Result<Url> {
    let (owner, name) = repo.project.split_once('/').ok_or(ConnectionError::Scope)?;
    let mut url = Url::parse(&format!("repo://{owner}/{name}/sha/{sha}/contents"))
        .map_err(|_| ConnectionError::Scope)?;
    url.path_segments_mut()
        .map_err(|_| ConnectionError::Scope)?
        .extend(path.split('/'));
    Ok(url)
}
