use axum::http::StatusCode;
use rig::{completion::CompletionError, providers::openai::completion as openai};
use serde::{Deserialize, de::IgnoredAny};
use uuid::Uuid;

use crate::agent_connections as c;

use super::types::{Cite, Error, Result};

const MAX_ANSWER: usize = 24 * 1024;
const LEGACY_OUTCOME_PREFIX: &str = "LiveNote outcome for that request: ";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyOutcome {
    #[serde(rename = "changed")]
    _changed: Vec<IgnoredAny>,
    #[serde(rename = "cites")]
    _cites: Vec<Cite>,
    #[serde(rename = "searchPhrases")]
    _search_phrases: Vec<String>,
}

pub(super) fn without_legacy_outcome(text: &str) -> &str {
    let trimmed = text.trim_end();
    let candidate = trimmed
        .rmatch_indices(LEGACY_OUTCOME_PREFIX)
        .find_map(|(start, prefix)| {
            let before = &trimmed[..start];
            let answer = if before.is_empty() {
                ""
            } else {
                before.strip_suffix("\n\n")?
            };
            let json = &trimmed[start + prefix.len()..];
            serde_json::from_str::<LegacyOutcome>(json)
                .ok()
                .map(|_| answer.trim_end())
        });
    candidate.unwrap_or(text)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyFinal {
    answer: String,
    cites: Vec<Uuid>,
}

pub(super) fn normalize_final(
    reply: String,
    question: &str,
    has_ref: impl Fn(Uuid) -> bool,
) -> Result<(String, Vec<Uuid>)> {
    let answer = without_legacy_outcome(&reply);
    let trimmed = answer.trim();
    if reply.len() > MAX_ANSWER || trimmed.is_empty() {
        return Err(invalid_final());
    }
    // При явном запросе JSON или кода даже точная старая форма может быть данными.
    if question
        .split(|ch: char| !ch.is_alphanumeric())
        .any(|word| {
            matches!(
                word.to_lowercase().as_str(),
                "json" | "code" | "код" | "кода" | "schemas" | "schema"
            )
        })
    {
        return Ok((answer.into(), Vec::new()));
    }
    if let Some(legacy) = parse_envelope(trimmed) {
        validate_envelope(&legacy, has_ref)?;
        return Ok((legacy.answer, legacy.cites));
    }
    // Отдельный последний блок — служебный только при совпадении текста
    // или наличии ссылок, которые выдали инструменты этого хода.
    for (index, _) in trimmed.rmatch_indices("\n\n") {
        let (prose, tail) = trimmed.split_at(index);
        let Some(legacy) = parse_envelope(tail.trim()) else {
            continue;
        };
        if prose.trim() != legacy.answer.trim()
            && (legacy.cites.is_empty() || !legacy.cites.iter().copied().all(&has_ref))
        {
            break;
        }
        validate_envelope(&legacy, has_ref)?;
        return Ok((prose.trim_end().into(), legacy.cites));
    }
    Ok((answer.into(), Vec::new()))
}

fn parse_envelope(text: &str) -> Option<LegacyFinal> {
    let json = text
        .strip_prefix("```json\n")
        .and_then(|text| text.strip_suffix("\n```"))
        .unwrap_or(text);
    serde_json::from_str(json).ok()
}

fn validate_envelope(legacy: &LegacyFinal, has_ref: impl Fn(Uuid) -> bool) -> Result<()> {
    if legacy.answer.trim().is_empty()
        || legacy.cites.len() > 12
        || !legacy.cites.iter().copied().all(has_ref)
    {
        return Err(invalid_final());
    }
    Ok(())
}

pub(super) fn finish_reason(response: &openai::CompletionResponse) -> Option<&str> {
    let [choice] = response.choices.as_slice() else {
        return None;
    };
    match &choice.message {
        openai::Message::Assistant { content, .. }
            if !content
                .iter()
                .any(|item| matches!(item, openai::AssistantContent::Refusal { .. })) =>
        {
            Some(&choice.finish_reason)
        }
        _ => None,
    }
}

pub(super) fn model_error(error: CompletionError) -> Error {
    use c::ModelError;
    let error = c::completion_error(error);
    let (code, message) = match error {
        ModelError::Http(status @ (StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)) => (
            "model_auth",
            format!(
                "Сервис модели отклонил учётные данные (HTTP {}).",
                status.as_u16()
            ),
        ),
        ModelError::Http(StatusCode::BAD_REQUEST) => (
            "model_request_rejected",
            "Сервис модели отклонил запрос (HTTP 400).".into(),
        ),
        ModelError::Http(StatusCode::TOO_MANY_REQUESTS) => (
            "model_rate_limited",
            "Сервис модели ограничил частоту запросов (HTTP 429).".into(),
        ),
        ModelError::Http(_) => ("model_http_error", error.to_string()),
        ModelError::Timeout => ("model_timeout", error.to_string()),
        ModelError::Connect => ("model_connect", error.to_string()),
        ModelError::InterruptedResponse => ("model_response_interrupted", error.to_string()),
        ModelError::Request => ("model_request_failed", error.to_string()),
        ModelError::InvalidResponse => ("invalid_model_response", error.to_string()),
        ModelError::ResponseTooLarge => ("model_response_too_large", error.to_string()),
    };
    Error::new(StatusCode::BAD_GATEWAY, code, message)
}

pub(super) fn invalid_final() -> Error {
    Error::new(
        StatusCode::BAD_GATEWAY,
        "invalid_model_final",
        "Модель не вернула корректный итог. Повторите запрос или выберите другую модель.",
    )
}
