use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufReader, ErrorKind},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

use axum::http::StatusCode;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use super::{
    binding::blocking,
    context::{HistoryTurn, TokenLimit, estimate},
    model_protocol::without_legacy_outcome,
    progress::{Progress, Reporter},
    types::{Conversation, Error, Result, SessionId, Summary, Turn, TurnId, TurnState},
};
use rig::completion::{Document, Message};

const RETAINED: usize = 10;
const UNTITLED: &str = "Новый разговор";

pub(super) struct History {
    file: PathBuf,
    data: Mutex<Option<Database>>,
    pub admission: tokio::sync::Mutex<()>,
}

impl History {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            data: Mutex::new(None),
            admission: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn run<T: Send + 'static>(
        self: &Arc<Self>,
        call: impl FnOnce(&mut Database, &Path) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let history = self.clone();
        blocking(move || {
            let mut guard = history.data.lock().map_err(|_| Error::storage())?;
            if guard.is_none() {
                *guard = Some(Database::load(&history.file)?);
            }
            let database = guard.as_mut().ok_or_else(Error::storage)?;
            call(database, &history.file)
        })
        .await
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Database {
    sessions: Vec<Session>,
    receipts: HashMap<TurnId, Receipt>,
    #[serde(skip)]
    live: Option<tokio::sync::watch::Receiver<Progress>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    summary: Summary,
    turns: Vec<Turn>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    search_phrases: HashMap<TurnId, Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Receipt {
    session: SessionId,
    digest: String,
}

impl Database {
    fn load(file: &Path) -> Result<Self> {
        let mut data: Self = match File::open(file) {
            Ok(file) => {
                serde_json::from_reader(BufReader::new(file)).map_err(|_| Error::storage())?
            }
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Self::default()),
            Err(_) => return Err(Error::storage()),
        };
        let mut recovered = false;
        for session in &mut data.sessions {
            for turn in &mut session.turns {
                match &mut turn.state {
                    TurnState::Running => {
                        recovered = true;
                        turn.state = TurnState::Interrupted {
                            error: Error::new(
                                StatusCode::SERVICE_UNAVAILABLE,
                                "interrupted",
                                "LiveNote закрылся до завершения сообщения",
                            )
                            .fault,
                        };
                    }
                    TurnState::Done { answer, .. } => {
                        let clean_len = without_legacy_outcome(answer).len();
                        answer.truncate(clean_len);
                    }
                    TurnState::Failed { .. } | TurnState::Interrupted { .. } => {}
                }
            }
        }
        if recovered {
            data.save(file)?;
        }
        Ok(data)
    }

    fn save(&self, file: &Path) -> Result<()> {
        let directory = file.parent().ok_or_else(Error::storage)?;
        fs::create_dir_all(directory).map_err(|_| Error::storage())?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(directory).map_err(|_| Error::storage())?;
        serde_json::to_writer(temporary.as_file_mut(), self).map_err(|_| Error::storage())?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| Error::storage())?;
        temporary.persist(file).map_err(|_| Error::storage())?;
        Ok(())
    }

    pub fn list(&self) -> Vec<Summary> {
        self.sessions
            .iter()
            .map(|session| session.summary.clone())
            .collect()
    }

    pub fn conversation(&self, id: SessionId) -> Result<Conversation> {
        let session = self.session(id)?;
        Ok(Conversation {
            session: session.summary.clone(),
            turns: session.turns.clone(),
        })
    }

    pub fn live_turn(&self, session: SessionId, id: TurnId) -> Result<Turn> {
        let mut turn = self.turn(session, id)?;
        if matches!(turn.state, TurnState::Running) {
            turn.progress = self.live.as_ref().map(|live| live.borrow().clone());
        }
        Ok(turn)
    }

    fn turn(&self, session: SessionId, id: TurnId) -> Result<Turn> {
        self.session(session)?
            .turns
            .iter()
            .find(|turn| turn.id == id)
            .cloned()
            .ok_or_else(Error::missing)
    }

    fn session(&self, id: SessionId) -> Result<&Session> {
        self.sessions
            .iter()
            .find(|entry| entry.summary.id == id)
            .ok_or_else(Error::missing)
    }

    fn promote(&mut self, id: SessionId, at: &str) -> Result<&mut Session> {
        let index = self
            .sessions
            .iter()
            .position(|entry| entry.summary.id == id)
            .ok_or_else(Error::missing)?;
        let mut session = self.sessions.remove(index);
        session.summary.updated_at = at.into();
        self.sessions.insert(0, session);
        self.sessions.first_mut().ok_or_else(Error::storage)
    }

    pub fn create(&mut self, id: SessionId, file: &Path) -> Result<Summary> {
        if let Ok(session) = self.session(id) {
            return Ok(session.summary.clone());
        }
        if self.receipts.values().any(|receipt| receipt.session == id) {
            return Err(Error::missing());
        }
        let mut next = self.clone();
        let summary = Summary {
            id,
            title: UNTITLED.into(),
            updated_at: now(),
        };
        next.sessions.insert(
            0,
            Session {
                summary: summary.clone(),
                turns: vec![],
                search_phrases: HashMap::new(),
            },
        );
        if next.sessions.len() > RETAINED {
            let index = next
                .sessions
                .iter()
                .rposition(|session| !session.running())
                .ok_or_else(Error::busy)?;
            next.sessions.remove(index);
        }
        next.save(file)?;
        *self = next;
        Ok(summary)
    }

    pub fn replay(&self, session: SessionId, id: TurnId, digest: &str) -> Result<Option<Turn>> {
        if let Some(receipt) = self.receipts.get(&id) {
            if receipt.session != session || receipt.digest != digest {
                return Err(Error::new(
                    StatusCode::CONFLICT,
                    "id_reused",
                    "Идентификатор сообщения уже использован",
                ));
            }
            return self.turn(session, id).map(Some);
        }
        self.session(session)?;
        self.ensure_idle()?;
        Ok(None)
    }

    fn ensure_idle(&self) -> Result<()> {
        if self.sessions.iter().any(Session::running) {
            Err(Error::busy())
        } else {
            Ok(())
        }
    }

    pub fn start(&mut self, input: Start, file: &Path) -> Result<Started> {
        let Start {
            session,
            id,
            text,
            digest,
            context_limit,
        } = input;
        let mut next = self.clone();
        let at = now();
        let current = next.promote(session, &at)?;
        let history = current.context(context_limit)?;
        if current.turns.is_empty() {
            current.summary.title = title(&text);
        }
        let turn = Turn {
            id,
            text,
            at,
            progress: None,
            state: TurnState::Running,
        };
        current.turns.push(turn.clone());
        next.receipts.insert(id, Receipt { session, digest });
        next.save(file)?;
        let (reporter, live) = Reporter::new(context_limit.get());
        next.live = Some(live);
        *self = next;
        Ok(Started {
            turn,
            history,
            reporter,
        })
    }

    pub fn finish(
        &mut self,
        session: SessionId,
        id: TurnId,
        outcome: (TurnState, Vec<String>),
        file: &Path,
    ) -> Result<()> {
        let progress = self.live.as_ref().map(|live| live.borrow().clone());
        let current = self.promote(session, &now())?;
        let turn = current
            .turns
            .iter_mut()
            .find(|turn| turn.id == id)
            .ok_or_else(Error::missing)?;
        let (state, search_phrases) = outcome;
        turn.state = state;
        turn.progress = progress;
        if !search_phrases.is_empty() {
            current.search_phrases.insert(id, search_phrases);
        }
        self.live = None;
        // После публикации документов не подменяем итог записи ошибкой сохранения истории.
        self.save(file)
    }
}

impl Session {
    fn running(&self) -> bool {
        self.turns
            .last()
            .is_some_and(|turn| matches!(turn.state, TurnState::Running))
    }

    fn context(&self, limit: TokenLimit) -> Result<Vec<HistoryTurn>> {
        let mut remaining = limit.get();
        let mut history = Vec::new();
        for turn in self.turns.iter().rev() {
            let phrases = self
                .search_phrases
                .get(&turn.id)
                .map_or(&[][..], Vec::as_slice);
            let (answer, outcome) = match &turn.state {
                TurnState::Done {
                    answer,
                    changed,
                    cites,
                } if !changed.is_empty() || !cites.is_empty() || !phrases.is_empty() => {
                    let facts = serde_json::json!({"changed":changed,"cites":cites,"searchPhrases":phrases});
                    let document = Document {
                        id: format!("livenote-history-turn-{}", history.len() + 1),
                        text: facts.to_string(),
                        additional_props: HashMap::new(),
                    };
                    (answer.clone(), Some(document))
                }
                TurnState::Done { answer, .. } => (answer.clone(), None),
                TurnState::Failed { error } => {
                    (format!("The request failed ({}).", error.code), None)
                }
                TurnState::Interrupted { .. } => ("The request was interrupted.".into(), None),
                TurnState::Running => continue,
            };
            let messages = [Message::user(turn.text.clone()), Message::assistant(answer)];
            let outcome_tokens = outcome
                .as_ref()
                .map(|doc| estimate(&Message::user(doc.to_string())))
                .transpose()?
                .unwrap_or_default();
            let tokens = estimate(&messages)? + outcome_tokens;
            let Some(rest) = remaining.checked_sub(tokens) else {
                break;
            };
            remaining = rest;
            history.push(HistoryTurn {
                messages,
                outcome,
                tokens,
            });
        }
        history.reverse();
        Ok(history)
    }
}

pub(super) struct Start {
    pub session: SessionId,
    pub id: TurnId,
    pub text: String,
    pub digest: String,
    pub context_limit: TokenLimit,
}

pub(super) struct Started {
    pub turn: Turn,
    pub history: Vec<HistoryTurn>,
    pub reporter: Reporter,
}

fn title(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(72)
        .collect()
}

fn now() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
