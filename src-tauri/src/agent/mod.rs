mod binding;
mod context;
mod history;
mod model_loop;
mod model_protocol;
mod native;
mod policy;
mod progress;
mod sources;
mod tools;
pub(crate) mod types;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::http::StatusCode;
use livenote_vault_service::agent_documents as d;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::{agent_bindings as b, agent_connections as c};

use binding::{BindingVault, blocking, conflict_path};
use history::{History, Start, Started};
use progress::{Event, Reporter, Source};
use sources::{SourceConfig, Sources};
use types::{Conversation, Error, Result, SessionId, Submit, Summary, Turn, TurnId, TurnState};

const EXECUTION_LIMIT: Duration = Duration::from_secs(180);

#[derive(Clone)]
pub(crate) struct AgentRuntime(Arc<Shared>);

struct Shared {
    root: PathBuf,
    history: Mutex<HashMap<String, Arc<History>>>,
    connections: c::Connections,
    bindings: Arc<b::Bindings>,
    shutdown: CancellationToken,
    tasks: TaskTracker,
}

impl AgentRuntime {
    pub fn new(
        data_dir: PathBuf,
        connections: c::Connections,
        shutdown: CancellationToken,
    ) -> Self {
        let root = data_dir.join("agent");
        Self(Arc::new(Shared {
            bindings: Arc::new(b::Bindings::new(root.join("bindings"))),
            root,
            connections,
            shutdown,
            history: Mutex::default(),
            tasks: TaskTracker::new(),
        }))
    }

    pub fn connections(&self) -> &c::Connections {
        &self.0.connections
    }

    pub async fn drain(&self) {
        self.0.tasks.close();
        self.0.tasks.wait().await;
    }

    fn history(&self, vault: &d::VaultRef) -> Result<Arc<History>> {
        c::VaultId::new(vault.id())?;
        let mut vaults = self.0.history.lock().map_err(|_| Error::storage())?;
        Ok(vaults
            .entry(vault.id().into())
            .or_insert_with(|| {
                Arc::new(History::new(
                    self.0.root.join(vault.id()).join("sessions.json"),
                ))
            })
            .clone())
    }

    pub async fn sessions(&self, vault: &d::VaultRef) -> Result<Vec<Summary>> {
        self.history(vault)?.run(|db, _| Ok(db.list())).await
    }

    pub async fn create_session(&self, vault: &d::VaultRef, id: SessionId) -> Result<Summary> {
        self.history(vault)?
            .run(move |db, file| db.create(id, file))
            .await
    }

    pub async fn session(&self, vault: &d::VaultRef, id: SessionId) -> Result<Conversation> {
        self.history(vault)?
            .run(move |db, _| db.conversation(id))
            .await
    }

    pub async fn get_turn(
        &self,
        vault: &d::VaultRef,
        session: SessionId,
        turn: TurnId,
    ) -> Result<Turn> {
        self.history(vault)?
            .run(move |db, _| db.live_turn(session, turn))
            .await
    }

    pub async fn submit(
        &self,
        vault: d::VaultRef,
        session: SessionId,
        input: Submit,
    ) -> Result<Turn> {
        let history = self.history(&vault)?;
        let runtime = self.clone();
        let (send, wait) = oneshot::channel();
        // После приёма сообщения HTTP-клиент не управляет временем жизни операции.
        drop(self.0.tasks.spawn(async move {
            let accepted = runtime.admit(vault, &history, session, input).await;
            match accepted {
                Ok(Admission::Started(job)) => {
                    drop(send.send(Ok(job.turn.clone())));
                    let id = job.turn.id;
                    let status = runtime.execute(*job).await;
                    if history
                        .run(move |db, file| db.finish(session, id, status, file))
                        .await
                        .is_err()
                    {
                        eprintln!("Не удалось сохранить итог сообщения агента");
                    }
                }
                Ok(Admission::Replay(turn)) => drop(send.send(Ok(turn))),
                Err(error) => drop(send.send(Err(error))),
            }
        }));
        wait.await.map_err(|_| Error::storage())?
    }

    async fn admit(
        &self,
        vault: d::VaultRef,
        history: &Arc<History>,
        session: SessionId,
        input: Submit,
    ) -> Result<Admission> {
        let _lock = history.admission.lock().await;
        let Submit {
            id,
            text,
            search,
            focus,
            digest,
            context_limit,
        } = input;
        let hash = digest.clone();
        if let Some(turn) = history
            .run(move |db, _| db.replay(session, id, &hash))
            .await?
        {
            return Ok(Admission::Replay(turn));
        }
        if self.0.shutdown.is_cancelled() {
            return Err(Error::closing());
        }
        let (folder, focal_context) = focus_context(&focus)?;
        let docs = vault.turn(focus).await?;
        let started = history
            .run(move |db, file| {
                db.start(
                    Start {
                        session,
                        id,
                        text,
                        digest,
                        context_limit,
                    },
                    file,
                )
            })
            .await?;
        let Started {
            turn,
            history,
            reporter,
        } = started;
        let context = model_loop::Context {
            focus: focal_context,
            text: turn.text.clone(),
            history,
            limit: context_limit,
        };
        let work = Work {
            vault,
            docs,
            folder,
            search,
            context,
        };
        Ok(Admission::Started(Box::new(Job {
            turn,
            reporter,
            work,
        })))
    }

    async fn execute(&self, job: Job) -> (TurnState, Vec<String>) {
        let Job { reporter, work, .. } = job;
        let prepared = tokio::select! {
            biased;
            () = self.0.shutdown.cancelled() => return (TurnState::Interrupted { error: Error::closing().fault }, Vec::new()),
            result = tokio::time::timeout(EXECUTION_LIMIT, self.prepare(work, &reporter)) => match result {
                Ok(Ok(prepared)) => prepared,
                Ok(Err(error)) => return (TurnState::Failed { error: error.fault }, Vec::new()),
                Err(_) => return (TurnState::Failed { error: Error::new(StatusCode::GATEWAY_TIMEOUT,
                    "agent_timeout", "Агент не завершил запрос за 3 минуты. Изменения этого запроса не сохранены.").fault }, Vec::new()),
            },
        };
        if !prepared.docs.has_staged_changes() {
            return (TurnState::Done {
                answer: prepared.answer,
                cites: prepared.cites,
                changed: Vec::new(),
            }, prepared.search_phrases);
        }
        reporter.start(Event::Commit {
            source: Source::Vault,
        });
        // После начала публикации ждём её итог. Отмена future не отменяет запись на диске.
        match prepared.docs.commit().await {
            Ok(changed) => (TurnState::Done {
                answer: prepared.answer,
                cites: prepared.cites,
                changed,
            }, prepared.search_phrases),
            Err(error) => (TurnState::Failed {
                error: Error::from(error).fault,
            }, Vec::new()),
        }
    }

    async fn prepare(&self, work: Work, reporter: &Reporter) -> Result<model_loop::Prepared> {
        let Work {
            vault,
            docs,
            folder,
            search,
            context,
        } = work;
        let id = c::VaultId::new(vault.id())?;
        let connections = self.0.connections.clone();
        let model = connections.model(&id).await?;
        let window = context::Window {
            reporter,
            limit: context.limit,
            history: &context.history,
        };
        let team_rules = vault.instructions().await?;
        let bindings = self.0.bindings.clone();
        let binding = blocking(move || Ok(bindings.resolve(&BindingVault(vault), &folder)?)).await?;
        let sources = Sources::new(
            connections,
            id,
            SourceConfig { mode: search, binding },
            reporter,
        );
        let agent = model_loop::Loop::new(docs, sources, policy::Policy::new(&model, &context.text));
        agent.run(&model, &window, &context, team_rules).await
    }

    pub async fn binding(&self, vault: d::VaultRef, folder: String) -> Result<b::BindingView> {
        if !vault.folder_exists(&folder).await? {
            return Err(Error::missing());
        }
        let store = self.0.bindings.clone();
        blocking(move || Ok(store.get(&BindingVault(vault), &folder)?)).await
    }

    pub async fn set_binding(
        &self,
        vault: d::VaultRef,
        input: b::BindingRequest,
    ) -> Result<b::BindingView> {
        let folder = input.folder.clone();
        if !vault.folder_exists(&folder).await? {
            return Err(Error::missing());
        }
        let store = self.0.bindings.clone();
        blocking(move || {
            store
                .put(&BindingVault(vault), input)
                .map_err(|error| conflict_path(error.into(), folder))
        })
        .await
    }
}

enum Admission {
    Replay(Turn),
    Started(Box<Job>),
}

struct Job {
    turn: Turn,
    reporter: Reporter,
    work: Work,
}

struct Work {
    vault: d::VaultRef,
    docs: d::DocTurn,
    folder: String,
    search: types::Search,
    context: model_loop::Context,
}

fn focus_context(focus: &d::CapturedFocus) -> Result<(String, Value)> {
    let parent = |path: &str| {
        path.rsplit_once('/')
            .map_or("", |(parent, _)| parent)
            .to_owned()
    };
    Ok(match focus {
        d::CapturedFocus::Folder { folder } => {
            (folder.clone(), json!({"kind":"folder","folder":folder}))
        }
        d::CapturedFocus::Document { path, .. } => {
            (parent(path), json!({"kind":"document","path":path}))
        }
        d::CapturedFocus::Diagram {
            path,
            format,
            target,
            selected,
            ..
        } => {
            if selected.len() > 200
                || selected.iter().any(|item| {
                    item.id.is_empty()
                        || item.id.len() > 512
                        || item
                            .page_id
                            .as_ref()
                            .is_some_and(|id| id.is_empty() || id.len() > 512)
                })
            {
                return Err(Error::invalid(
                    "Выбрано слишком много элементов или неверен их идентификатор",
                ));
            }
            let selection: Vec<_> = selected
                .iter()
                .map(|item| {
                    let kind = match item.kind {
                        d::ElementKind::Node => "node",
                        d::ElementKind::Edge => "edge",
                        d::ElementKind::Element => "element",
                    };
                    json!({"id":item.id,"kind":kind,"pageId":item.page_id})
                })
                .collect();
            let target = match target {
                d::Target::File => json!({"kind":"file"}),
                d::Target::Asset { path } => json!({"kind":"asset","path":path}),
                d::Target::Inline { from, to } => json!({"kind":"inline","from":from,"to":to}),
            };
            (
                parent(path),
                json!({"kind":"diagram","path":path,"format":format,"target":target,"selected":selection}),
            )
        }
    })
}
