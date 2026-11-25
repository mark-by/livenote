use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use livenote_vault_service::agent_documents as d;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
    binding::blocking,
    policy::Policy,
    progress::{Event, Reporter, Source},
    types::{Cite, Error, Result, Search},
};
use crate::{agent_bindings as b, agent_connections as c};

impl Source {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Vault => "vault",
            Self::Local => "localCode",
            Self::Remote => "remoteCode",
            Self::Confluence => "confluence",
        }
    }
}

enum Reference {
    Vault,
    Local(String),
    Mcp(Source, c::SourceRef),
}

type Hit = (Uuid, Reference, Cite, String);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Evidence {
    Empty,
    Context,
    Retrieved,
}

pub(super) struct Sources<'a> {
    pub reporter: &'a Reporter,
    connections: c::Connections,
    vault: c::VaultId,
    binding: Option<Arc<b::BoundSource>>,
    mode: Search,
    remote_queries: Option<Vec<String>>,
    remaining: std::collections::VecDeque<Source>,
    attempted: bool,
    discovered: bool,
    unavailable: bool,
    remote_attempts: HashSet<usize>,
    mcp: HashMap<Source, c::ReadMcp>,
    refs: HashMap<Uuid, (Reference, Cite, Evidence)>,
    issued: Vec<Uuid>,
    pub search_phrases: Vec<String>,
}

impl<'a> Sources<'a> {
    pub fn new(
        connections: c::Connections,
        vault: c::VaultId,
        config: SourceConfig,
        reporter: &'a Reporter,
    ) -> Self {
        let SourceConfig { mode, binding } = config;
        let order = match mode {
            Search::DocsFirst => [
                Source::Vault,
                Source::Confluence,
                Source::Local,
                Source::Remote,
            ],
            Search::CodeFirst => [
                Source::Local,
                Source::Remote,
                Source::Vault,
                Source::Confluence,
            ],
        };
        let remaining = order
            .into_iter()
            .filter(|source| match source {
                Source::Vault | Source::Confluence => true,
                Source::Local => binding.as_ref().is_some_and(|b| b.local_dir.is_some()),
                Source::Remote => binding.as_ref().is_some_and(|b| b.repo.is_some()),
            })
            .collect();
        Self {
            reporter,
            connections,
            vault,
            binding: binding.map(Arc::new),
            mode,
            remote_queries: None,
            remaining,
            attempted: false,
            discovered: false,
            unavailable: false,
            remote_attempts: HashSet::new(),
            mcp: HashMap::new(),
            refs: HashMap::new(),
            issued: Vec::new(),
            search_phrases: Vec::new(),
        }
    }

    pub const fn mode(&self) -> &'static str {
        match self.mode {
            Search::DocsFirst => "docsFirst",
            Search::CodeFirst => "codeFirst",
        }
    }

    pub const fn code_first(&self) -> bool {
        matches!(self.mode, Search::CodeFirst)
    }

    pub fn current(&self) -> Option<Source> {
        self.remaining.front().copied()
    }

    pub fn vault_available(&self) -> bool {
        !self.remaining.contains(&Source::Vault) || self.current() == Some(Source::Vault)
    }

    pub fn advance(&mut self, code_relevant: bool) -> Result<Value> {
        if !self.attempted || self.current().is_none() {
            return Err(Error::invalid(
                "Сначала выполните поиск в текущем источнике",
            ));
        }
        if !self.code_first() && self.current() == Some(Source::Vault) && code_relevant {
            self.remaining
                .retain(|source| *source != Source::Confluence);
            self.remaining.push_back(Source::Confluence);
        }
        self.remaining.pop_front();
        if self.remote_queries.as_ref().is_some_and(Vec::is_empty) {
            self.remaining
                .retain(|source| !matches!(source, Source::Confluence | Source::Remote));
        }
        self.attempted = false;
        self.discovered = false;
        self.unavailable = false;
        self.remote_attempts.clear();
        self.reporter.start(Event::NextSource {
            source: self.current(),
        });
        Ok(json!({"source":self.current().map(Source::label)}))
    }

    pub fn cite(&self, id: Uuid) -> Option<&Cite> {
        self.refs
            .get(&id)
            .and_then(|(_, cite, evidence)| (*evidence != Evidence::Empty).then_some(cite))
    }

    pub fn has_evidence(&self) -> bool {
        self.refs
            .values()
            .any(|(_, _, evidence)| *evidence == Evidence::Retrieved)
    }

    pub fn ref_count(&self) -> usize {
        self.issued.len()
    }

    pub fn discard_refs(&mut self, from: usize) {
        for id in self.issued.drain(from..) {
            self.refs.remove(&id);
        }
    }

    pub fn doc_read(&mut self, read: d::Read) -> Value {
        if self.current() == Some(Source::Vault) {
            self.attempted = true;
        }
        self.remember(
            read.read_id.0,
            Reference::Vault,
            read.fragment.cite.clone().into(),
            &read.fragment.text,
            Evidence::Retrieved,
        );
        json!(read)
    }

    fn remember(
        &mut self,
        id: Uuid,
        reference: Reference,
        cite: Cite,
        text: &str,
        evidence: Evidence,
    ) {
        let evidence = if text.trim().is_empty() {
            Evidence::Empty
        } else {
            evidence
        };
        self.refs.insert(id, (reference, cite, evidence));
        self.issued.push(id);
    }

    fn hits(&mut self, hits: Vec<Hit>, evidence: Evidence) -> Vec<Value> {
        hits.into_iter()
            .map(|(id, reference, cite, excerpt)| {
                let value = json!({"ref": id, "cite": &cite, "excerpt": excerpt});
                self.remember(id, reference, cite, &excerpt, evidence);
                value
            })
            .collect()
    }

    pub async fn discover(&mut self, docs: &d::DocTurn) -> Result<Vec<Value>> {
        if self.discovered {
            return Ok(Vec::new());
        }
        let hits = match self.current() {
            Some(Source::Vault) => {
                self.reporter.start(Event::Search {
                    source: Source::Vault,
                });
                vault_hits(docs.discover().await?)
            }
            Some(Source::Local) => {
                self.reporter.start(Event::Search {
                    source: Source::Local,
                });
                self.local_hits(None).await?
            }
            Some(Source::Confluence | Source::Remote) | None => return Ok(Vec::new()),
        };
        self.discovered = true;
        self.attempted = true;
        Ok(self.hits(hits, Evidence::Context))
    }

    pub async fn search(
        &mut self,
        docs: &d::DocTurn,
        query: d::Query,
        remote_index: Option<usize>,
        policy: &Policy<'_>,
    ) -> Result<Value> {
        let source = self
            .current()
            .ok_or_else(|| Error::invalid("Источники закончились"))?;
        let limit = query.limit;
        let phrase = query.text.trim().to_owned();
        let hits = match source {
            Source::Vault => {
                self.reporter.start(Event::Search { source });
                vault_hits(docs.search(query).await?)
            }
            Source::Local => {
                self.reporter.start(Event::Search { source });
                self.local_hits(Some(b::Query {
                    text: query.text,
                    limit,
                }))
                .await?
            }
            Source::Remote | Source::Confluence => {
                return self
                    .search_remote(source, remote_index.unwrap_or(0), limit, policy)
                    .await;
            }
        };
        self.attempted = true;
        if !hits.is_empty()
            && phrase.len() <= 128
            && phrase.split_whitespace().count() <= 8
            && self.search_phrases.len() < 5
            && !self.search_phrases.contains(&phrase)
        {
            self.search_phrases.push(phrase);
        }
        let hits = self.hits(hits, Evidence::Retrieved);
        let mut data = json!({"source":source.label(), "hits":hits});
        if hits.is_empty() {
            let context = self.discover(docs).await?;
            if !context.is_empty() {
                data["context"] = json!(context);
            }
        }
        Ok(data)
    }

    async fn search_remote(
        &mut self,
        source: Source,
        index: usize,
        limit: usize,
        policy: &Policy<'_>,
    ) -> Result<Value> {
        if self.remote_queries.is_none() {
            self.remote_queries = Some(policy.remote_queries(self.reporter).await);
        }
        let queries = self.remote_queries.as_deref().unwrap_or_default();
        if queries.is_empty() || self.unavailable {
            self.attempted = true;
            return Ok(json!({"source":source.label(), "hits":[], "unavailable":true}));
        }
        let text = queries
            .get(index)
            .ok_or_else(|| Error::invalid("Выберите номер подготовленного внешнего запроса"))?
            .clone();
        if !self.remote_attempts.insert(index) {
            return Ok(
                json!({"source":source.label(), "hits":[], "remoteQueries":queries, "alreadySearched":true}),
            );
        }
        let (provider, scope) = self.scope(source)?;
        self.reporter.start(Event::Search { source });
        if !self.mcp.contains_key(&source) {
            let client = match self.connections.mcp(&self.vault, provider).await {
                Ok(client) => client,
                Err(c::ConnectionError::Missing) => {
                    self.attempted = true;
                    self.unavailable = true;
                    return Ok(json!({"source":source.label(), "hits":[], "unavailable":true}));
                }
                Err(error) => return Err(error.into()),
            };
            self.mcp.insert(source, client);
        }
        let client = self.mcp.get_mut(&source).ok_or_else(Error::missing)?;
        let hits = client
            .search(scope, c::Query { text, limit })
            .await?
            .into_iter()
            .map(|hit| {
                (
                    hit.source.id(),
                    Reference::Mcp(source, hit.source),
                    hit.cite.into(),
                    hit.excerpt,
                )
            })
            .collect();
        self.attempted = true;
        let hits = self.hits(hits, Evidence::Retrieved);
        Ok(json!({"source":source.label(), "hits":hits, "remoteQueries":self.remote_queries}))
    }

    async fn local_hits(&self, query: Option<b::Query>) -> Result<Vec<Hit>> {
        let binding = self.binding.clone().ok_or_else(Error::missing)?;
        blocking(move || {
            let code = b::LocalCode::default();
            let hits = match query {
                Some(query) => code.search(&binding, query)?,
                None => code.discover(&binding)?,
            };
            Ok(hits
                .into_iter()
                .map(|hit| match hit.cite {
                    b::Cite::LocalCode { ref path, .. } => (
                        Uuid::new_v4(),
                        Reference::Local(path.clone()),
                        hit.cite.into(),
                        hit.excerpt,
                    ),
                })
                .collect())
        })
        .await
    }

    fn scope(&self, source: Source) -> Result<(c::Provider, c::SearchScope)> {
        if source == Source::Confluence {
            return Ok((c::Provider::Confluence, c::SearchScope::Confluence));
        }
        let repo = self
            .binding
            .as_ref()
            .and_then(|binding| binding.repo.as_ref())
            .ok_or_else(Error::missing)?;
        let provider = match repo.provider {
            b::RepoProvider::Gitlab => c::RepoProvider::Gitlab,
            b::RepoProvider::Github => c::RepoProvider::Github,
        };
        let repo = c::Repo {
            provider,
            url: repo.url.clone(),
            reference: repo.reference.clone(),
        };
        Ok((provider.into(), c::SearchScope::Repo(repo)))
    }

    pub async fn read(&mut self, id: Uuid, lines: d::Lines) -> Result<Value> {
        let (reference, _, _) = self.refs.get(&id).ok_or_else(Error::missing)?;
        let (cite, text) = match reference {
            Reference::Vault => {
                return Err(Error::invalid("Для документов используйте read_vault"));
            }
            Reference::Local(path) => {
                let binding = self.binding.clone().ok_or_else(Error::missing)?;
                let path = path.clone();
                let lines = b::Lines {
                    first: lines.first,
                    last: lines.last,
                };
                self.reporter.start(Event::ReadSource {
                    source: Source::Local,
                });
                let result =
                    blocking(move || Ok(b::LocalCode::default().read(&binding, &path, lines)?))
                        .await?;
                (Cite::from(result.cite), result.text)
            }
            Reference::Mcp(source, target) => {
                let client = self.mcp.get_mut(source).ok_or_else(Error::missing)?;
                let lines = c::Lines {
                    first: lines.first,
                    last: lines.last,
                };
                self.reporter.start(Event::ReadSource { source: *source });
                let result = client.read(target, lines).await?;
                (Cite::from(result.cite), result.text)
            }
        };
        let id = Uuid::new_v4();
        let value = json!({"ref": id, "cite": &cite, "text": text});
        // Новый идентификатор указывает на точную строку чтения, а не на строку поиска.
        let reference = match reference {
            Reference::Vault => return Err(Error::missing()),
            Reference::Local(path) => Reference::Local(path.clone()),
            Reference::Mcp(source, target) => Reference::Mcp(*source, target.clone()),
        };
        self.remember(id, reference, cite, &text, Evidence::Retrieved);
        Ok(value)
    }
}

fn vault_hits(hits: Vec<d::Hit>) -> Vec<Hit> {
    hits.into_iter()
        .map(|hit| {
            (
                hit.reference,
                Reference::Vault,
                hit.cite.into(),
                hit.excerpt,
            )
        })
        .collect()
}

pub(super) struct SourceConfig {
    pub mode: Search,
    pub binding: Option<b::BoundSource>,
}
