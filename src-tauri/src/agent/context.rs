use axum::http::StatusCode;
use rig::completion::{CompletionRequest, Document, Message};
use serde::Serialize;

use super::{
    progress::{Event, Reporter},
    types::{Error, Result},
};

#[derive(Clone, Copy)]
pub(super) struct TokenLimit(usize);

impl TokenLimit {
    pub fn parse(value: usize) -> Result<Self> {
        if (8_192..=1_048_576).contains(&value) {
            Ok(Self(value))
        } else {
            Err(Error::invalid(
                "Лимит контекста должен быть от 8 192 до 1 048 576 токенов",
            ))
        }
    }

    pub const fn get(self) -> usize {
        self.0
    }
}

impl Default for TokenLimit {
    fn default() -> Self {
        Self(65_536)
    }
}

pub(super) struct HistoryTurn {
    pub messages: [Message; 2],
    pub outcome: Option<Document>,
    pub tokens: usize,
}

pub(super) struct Window<'a> {
    pub reporter: &'a Reporter,
    pub limit: TokenLimit,
    pub history: &'a [HistoryTurn],
}

impl Window<'_> {
    pub fn prepare(
        &self,
        event: Event,
        request: &mut CompletionRequest,
        staged: bool,
    ) -> Result<()> {
        let base = estimate(&request.preamble)?
            + estimate(&request.chat_history)?
            + estimate(&request.tools)?;
        let limit = self.limit.get();
        if base > limit {
            self.reporter.context_tokens(base);
            let message = format!(
                "Для запроса нужно около {base} токенов. Лимит: {limit}. Увеличьте лимит или сузьте запрос."
            );
            return Err(stop("agent_context_too_large", message, staged));
        }
        let mut tokens = base;
        let mut first = self.history.len();
        for turn in self.history.iter().rev() {
            if tokens + turn.tokens > limit {
                break;
            }
            tokens += turn.tokens;
            first -= 1;
        }
        let included = &self.history[first..];
        request
            .documents
            .extend(included.iter().filter_map(|turn| turn.outcome.clone()));
        let history = included
            .iter()
            .flat_map(|turn| turn.messages.iter().cloned());
        for (i, message) in history.enumerate() {
            request.chat_history.insert(i, message);
        }
        self.reporter.context_tokens(tokens);
        self.reporter.start(event);
        Ok(())
    }
}

pub(super) fn estimate<T: Serialize + ?Sized>(value: &T) -> Result<usize> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        Error::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "agent_context_serialization",
            "Не удалось подготовить контекст для модели.",
        )
    })?;
    // Токенизаторы моделей различаются. Учитываем, что для одного токена
    // русскоязычного текста обычно требуется меньше байтов, чем для ASCII.
    let weighted_bytes = bytes
        .iter()
        .map(|byte| if byte.is_ascii() { 1 } else { 2 })
        .sum::<usize>();
    Ok(weighted_bytes.div_ceil(4))
}

pub(super) fn stop(code: &str, mut message: String, staged: bool) -> Error {
    if staged {
        message.push_str(" Подготовленные правки не сохранены.");
    }
    Error::new(StatusCode::BAD_GATEWAY, code, message)
}
