use livenote_vault_service::agent_documents::NavigationTarget;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

const MAX_EVENTS: usize = 64;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    steps_used: usize,
    #[serde(default)]
    context_tokens: usize,
    #[serde(default)]
    context_limit_tokens: usize,
    events: Vec<Event>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum Event {
    Plan,
    Model,
    Verify,
    Search {
        source: Source,
    },
    NextSource {
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    ReadVault {
        source: Source,
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<NavigationTarget>,
    },
    ReadSource {
        source: Source,
    },
    Check {
        source: Source,
    },
    Stage {
        source: Source,
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<NavigationTarget>,
    },
    Commit {
        source: Source,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(super) enum Source {
    #[serde(rename = "vault")]
    Vault,
    #[serde(rename = "localCode")]
    Local,
    #[serde(rename = "remoteCode")]
    Remote,
    #[serde(rename = "confluence")]
    Confluence,
}

pub(super) struct Reporter(watch::Sender<Progress>);

impl Reporter {
    pub fn new(context_limit_tokens: usize) -> (Self, watch::Receiver<Progress>) {
        let initial = Progress {
            steps_used: 0,
            context_tokens: 0,
            context_limit_tokens,
            events: Vec::new(),
        };
        let (send, receive) = watch::channel(initial);
        (Self(send), receive)
    }

    pub fn context_tokens(&self, tokens: usize) {
        self.0
            .send_modify(|progress| progress.context_tokens = progress.context_tokens.max(tokens));
    }

    pub fn start(&self, event: Event) {
        self.0.send_modify(|progress| {
            match event {
                Event::Plan | Event::Model | Event::Verify => progress.steps_used += 1,
                Event::Search { .. }
                | Event::NextSource { .. }
                | Event::ReadVault { .. }
                | Event::ReadSource { .. }
                | Event::Check { .. }
                | Event::Stage { .. }
                | Event::Commit { .. } => {}
            }
            if progress.events.len() == MAX_EVENTS {
                progress.events.remove(0);
            }
            progress.events.push(event);
        });
    }

    pub fn set_target(&self, destination: NavigationTarget) {
        self.0.send_if_modified(|progress| {
            // Цикл агента завершает инструмент до начала следующего события.
            if let Some(Event::ReadVault { target, .. } | Event::Stage { target, .. }) =
                progress.events.last_mut()
            {
                *target = Some(destination);
                true
            } else {
                false
            }
        });
    }
}
