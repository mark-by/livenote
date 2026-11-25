mod confluence;
mod git;

use std::time::Duration;

use serde::{Deserialize, Serialize, Serializer};
use url::Url;
use uuid::Uuid;

use super::{ConnectionError, Provider, Repo, Result, mcp_wire::Session, repo::ScopedRepo};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub text: String,
    pub limit: usize,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lines {
    pub first: usize,
    pub last: usize,
}

impl Lines {
    fn count(self) -> Result<usize> {
        if self.first == 0 || self.last < self.first || self.last - self.first >= 200 {
            return Err(ConnectionError::Invalid);
        }
        Ok(self.last - self.first + 1)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Cite {
    Confluence {
        url: String,
        title: String,
    },
    RemoteCode {
        url: String,
        path: String,
        line: usize,
    },
}

pub enum SearchScope {
    Confluence,
    Repo(Repo),
}

#[derive(Clone)]
enum Location {
    Page(String),
    File {
        repo: ScopedRepo,
        sha: String,
        path: String,
    },
}

/// Ссылка на источник в текущем подключении. В JSON передаёт только UUID.
#[derive(Clone)]
pub struct SourceRef {
    id: Uuid,
    owner: Uuid,
    cite: Cite,
    location: Location,
}

impl SourceRef {
    pub const fn id(&self) -> Uuid {
        self.id
    }
}

impl Serialize for SourceRef {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        self.id.serialize(serializer)
    }
}

#[derive(Serialize)]
pub struct Hit {
    #[serde(rename = "ref")]
    pub source: SourceRef,
    pub cite: Cite,
    pub excerpt: String,
}

#[derive(Debug, Serialize)]
pub struct Fragment {
    pub cite: Cite,
    pub text: String,
}

pub struct ReadMcp {
    session: Session,
    provider: Provider,
    site: Url,
    owner: Uuid,
}

impl ReadMcp {
    pub(super) fn new(session: Session, provider: Provider, site: Url) -> Self {
        Self {
            session,
            provider,
            site,
            owner: Uuid::new_v4(),
        }
    }

    pub async fn search(&mut self, scope: SearchScope, query: Query) -> Result<Vec<Hit>> {
        let text = query.text.trim();
        if text.is_empty()
            || text.len() > 1024
            || text.chars().any(char::is_control)
            || query.limit == 0
        {
            return Err(ConnectionError::Invalid);
        }
        let limit = query.limit.min(20);
        let found = tokio::time::timeout(Duration::from_secs(30), self.find(scope, text, limit))
            .await
            .map_err(|_| ConnectionError::Upstream)??;
        Ok(found
            .into_iter()
            .map(|(location, cite, excerpt)| {
                let source = SourceRef {
                    id: Uuid::new_v4(),
                    owner: self.owner,
                    cite: cite.clone(),
                    location,
                };
                Hit {
                    source,
                    cite,
                    excerpt,
                }
            })
            .collect())
    }

    async fn find(
        &mut self,
        scope: SearchScope,
        text: &str,
        limit: usize,
    ) -> Result<Vec<(Location, Cite, String)>> {
        match scope {
            SearchScope::Confluence if self.provider == Provider::Confluence => {
                confluence::search(&mut self.session, &self.site, text, limit).await
            }
            SearchScope::Confluence => Err(ConnectionError::Scope),
            SearchScope::Repo(repo) => {
                let repo = ScopedRepo::new(repo, self.provider, &self.site)?;
                git::search(&mut self.session, repo, text, limit).await
            }
        }
    }

    pub async fn read(&mut self, source: &SourceRef, lines: Lines) -> Result<Fragment> {
        if source.owner != self.owner {
            return Err(ConnectionError::Scope);
        }
        lines.count()?;
        let (cite, text) = match &source.location {
            Location::Page(id) => {
                let text = confluence::read(&mut self.session, id).await?;
                (source.cite.clone(), window(&text, lines)?)
            }
            Location::File { repo, sha, path } => {
                let text = git::read(&mut self.session, repo, sha, path, lines).await?;
                (code_cite(repo, sha, path, lines.first)?, text)
            }
        };
        Ok(Fragment {
            cite,
            text: text.chars().take(24_000).collect(),
        })
    }
}

pub(super) const fn allowed(provider: Provider) -> &'static [&'static str] {
    match provider {
        Provider::Confluence => &["confluence_search", "confluence_get_page"],
        Provider::Gitlab => &["get_commit", "list_repository_tree", "get_repository_file"],
        Provider::Github => &["get_commit", "get_file_contents"],
    }
}

pub(super) const fn optional(provider: Provider) -> &'static [&'static str] {
    match provider {
        Provider::Confluence => &[],
        Provider::Gitlab => &["search_project_code"],
        Provider::Github => &["search_code"],
    }
}

fn window(text: &str, lines: Lines) -> Result<String> {
    let count = lines.count()?;
    let mut slice = text.lines().skip(lines.first - 1).take(count).peekable();
    if slice.peek().is_none() {
        return Err(ConnectionError::Scope);
    }
    Ok(slice.collect::<Vec<_>>().join("\n"))
}

fn code_cite(repo: &ScopedRepo, sha: &str, path: &str, line: usize) -> Result<Cite> {
    let url = repo.blob_url(sha, path, line)?.to_string();
    Ok(Cite::RemoteCode {
        url,
        path: path.into(),
        line,
    })
}
