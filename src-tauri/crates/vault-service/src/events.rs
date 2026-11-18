use std::sync::Weak;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use tokio::sync::broadcast::{Receiver, Sender, error::RecvError};

use crate::registry::Entry;

/// Поток событий одного хранилища. Освобождает подписку при удалении.
pub struct Subscription {
    receiver: Receiver<Value>,
    entry: Weak<Entry>,
}

impl Subscription {
    pub(crate) fn new(entry: &std::sync::Arc<Entry>) -> Self {
        Self {
            receiver: entry.events.subscribe(),
            entry: std::sync::Arc::downgrade(entry),
        }
    }

    /// Возвращает следующее событие или `None`, если хранилище закрыто.
    pub async fn recv(&mut self) -> Option<Value> {
        match self.receiver.recv().await {
            Ok(event) => Some(event),
            Err(RecvError::Closed) => None,
            // Старая очередь неполна; клиент запрашивает актуальный снимок.
            Err(RecvError::Lagged(_)) => Some(Value::Object(event("vault.updated", "", 0))),
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(entry) = self.entry.upgrade() {
            entry.touch();
        }
    }
}

pub fn now_ms() -> u64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

pub fn event(name: &str, path: &str, revision: u64) -> Map<String, Value> {
    [
        ("event", json!(name)),
        ("pageId", json!(path)),
        ("revision", json!(revision)),
        ("ts", json!(now_ms())),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

pub fn publish(sender: &Sender<Value>, event: Map<String, Value>) {
    match sender.send(Value::Object(event)) {
        Ok(_) | Err(_) => (), // События нужны только открытым подпискам.
    }
}
