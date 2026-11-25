use serde::{Deserialize, Serialize};
use url::Url;

use super::{ConnectionError, Result, transport};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Confluence,
    Gitlab,
    Github,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RepoProvider {
    Gitlab,
    Github,
}

impl From<RepoProvider> for Provider {
    fn from(value: RepoProvider) -> Self {
        match value {
            RepoProvider::Gitlab => Self::Gitlab,
            RepoProvider::Github => Self::Github,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Repo {
    pub provider: RepoProvider,
    pub url: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
}

#[derive(Clone)]
pub(super) struct ScopedRepo {
    pub(super) url: Url,
    pub(super) kind: RepoProvider,
    pub(super) project: String,
    pub(super) reference: String,
}

impl ScopedRepo {
    pub(super) fn new(repo: Repo, provider: Provider, site: &Url) -> Result<Self> {
        let mut url = transport::endpoint(&repo.url).map_err(|_| ConnectionError::Scope)?;
        if url.origin() != site.origin() || Provider::from(repo.provider) != provider {
            return Err(ConnectionError::Scope);
        }
        let path = url.path().trim_end_matches('/');
        let path = path.strip_suffix(".git").unwrap_or(path);
        let project = path
            .strip_prefix('/')
            .ok_or(ConnectionError::Scope)?
            .to_owned();
        let depth = project.split('/').count();
        if depth < 2
            || (provider == Provider::Github && depth != 2)
            || !project.split('/').all(project_segment)
        {
            return Err(ConnectionError::Scope);
        }
        let reference = repo.reference.unwrap_or_else(|| "HEAD".into());
        if reference.len() > 255
            || !reference.split('/').all(project_segment)
            || reference.contains("..")
        {
            return Err(ConnectionError::Scope);
        }
        url.set_path(&project);
        Ok(Self {
            url,
            kind: repo.provider,
            project,
            reference,
        })
    }

    pub(super) fn commit_path(&self, sha: &str) -> String {
        match self.kind {
            RepoProvider::Gitlab => format!("/{}/-/commit/{sha}", self.project),
            RepoProvider::Github => format!("/{}/commit/{sha}", self.project),
        }
    }

    pub(super) fn blob_url(&self, sha: &str, path: &str, line: usize) -> Result<Url> {
        let mut url = self.url.clone();
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| ConnectionError::Scope)?;
        if self.kind == RepoProvider::Gitlab {
            segments.push("-");
        }
        segments.push("blob").push(sha).extend(path.split('/'));
        drop(segments);
        url.set_fragment(Some(&format!("L{line}")));
        Ok(url)
    }
}

fn project_segment(part: &str) -> bool {
    !part.is_empty()
        && !matches!(part, "." | ".." | "-")
        && part
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

pub(super) fn file_path(path: &str) -> bool {
    path.len() <= 1024
        && path.split('/').all(|part| {
            !part.is_empty()
                && !matches!(part, "." | "..")
                && !part.eq_ignore_ascii_case(".git")
                && !part.contains(['\\', '%'])
                && !part.chars().any(char::is_control)
        })
}

pub(super) fn sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
