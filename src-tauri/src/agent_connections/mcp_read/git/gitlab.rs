use serde::Deserialize;
use serde_json::json;

use super::{
    Cite, ConnectionError, Lines, Location, Result, SCAN_FILES, SCAN_PAGES, ScopedRepo, Session,
    code_cite,
};
use crate::agent_connections::{repo, transport};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    sha: String,
    web_path: Option<String>,
    web_url: Option<String>,
}

#[derive(Deserialize)]
struct SearchEntry {
    path: String,
    #[serde(rename = "ref")]
    reference: String,
    startline: usize,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tree {
    entries: Vec<Entry>,
    page_info: PageInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
struct Entry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    mode: Option<String>,
}

#[derive(Deserialize)]
struct File {
    path: String,
    #[serde(rename = "ref")]
    reference: String,
    content: String,
    metadata: Metadata,
}

#[derive(Deserialize)]
struct Metadata {
    returned_lines: Option<ReturnedLines>,
}

#[derive(Deserialize)]
struct ReturnedLines {
    start: usize,
    end: usize,
}

pub(super) async fn commit(session: &mut Session, repo: &ScopedRepo) -> Result<String> {
    let args = json!({"project_id": repo.project, "commit_sha": repo.reference});
    let result: Commit = session.call("get_commit", args).await?.decode()?;
    let link = result
        .web_url
        .or(result.web_path)
        .ok_or(ConnectionError::Unsupported)?;
    let url = repo.url.join(&link).map_err(|_| ConnectionError::Scope)?;
    let url = transport::endpoint(url.as_str()).map_err(|_| ConnectionError::Scope)?;
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
        "project_id": repo.project,
        "search": query,
        "ref": sha,
        "per_page": limit,
    });
    let entries: Vec<SearchEntry> = session
        .call("search_project_code", args)
        .await?
        .decode()?;
    let query = query.to_lowercase();
    let mut hits = Vec::new();
    for entry in entries.into_iter().filter(|entry| {
        entry.reference == sha && entry.startline > 0 && repo::file_path(&entry.path)
    }) {
        let excerpt = entry
            .data
            .lines()
            .enumerate()
            .find(|(_, line)| line.to_lowercase().contains(&query))
            .or_else(|| entry.data.lines().enumerate().next());
        let Some((offset, excerpt)) = excerpt else {
            continue;
        };
        let line = entry.startline + offset;
        let cite = code_cite(repo, sha, &entry.path, line)?;
        let location = Location::File {
            repo: repo.clone(),
            sha: sha.into(),
            path: entry.path.clone(),
        };
        hits.push((location, cite, excerpt.chars().take(800).collect()));
        if hits.len() == limit {
            break;
        }
    }
    Ok(hits)
}

pub(super) async fn files(
    session: &mut Session,
    repo: &ScopedRepo,
    sha: &str,
) -> Result<Vec<String>> {
    let mut files = Vec::new();
    let mut args = json!({"project_id": repo.project, "ref": sha, "recursive": true});
    for _ in 0..SCAN_PAGES {
        let result: Tree = session
            .call("list_repository_tree", args.clone())
            .await?
            .decode()?;
        files.extend(
            result
                .entries
                .into_iter()
                .filter(|entry| {
                    entry.kind.eq_ignore_ascii_case("blob")
                        && entry.mode.as_deref() != Some("120000")
                        && repo::file_path(&entry.path)
                })
                .map(|entry| entry.path),
        );
        if files.len() >= SCAN_FILES || !result.page_info.has_next_page {
            break;
        }
        let after = result
            .page_info
            .end_cursor
            .ok_or(ConnectionError::Unsupported)?;
        if args["after"] == after {
            return Err(ConnectionError::Unsupported);
        }
        args["after"] = json!(after);
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
    let args = json!({"project_id": repo.project, "ref": sha, "file_path": path,
        "offset": lines.first - 1, "limit": lines.count()?});
    let reply = session.call_raw("get_repository_file", args).await?;
    if reply.is_error {
        return Err(ConnectionError::Scope);
    }
    let result: File = reply.decode()?;
    if result.path != path || result.reference != sha {
        return Err(ConnectionError::Scope);
    }
    let range = result
        .metadata
        .returned_lines
        .ok_or(ConnectionError::Scope)?;
    if range.start != lines.first
        || range.end < range.start
        || range.end > lines.last
        || result.content.lines().count() != range.end - range.start + 1
    {
        return Err(ConnectionError::Unsupported);
    }
    Ok(result.content)
}
