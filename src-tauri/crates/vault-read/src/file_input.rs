use std::time::{SystemTime, UNIX_EPOCH};

/// Метки времени проверенного файла.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileTimes {
    pub created: Option<SystemTime>,
    pub modified: SystemTime,
}

impl Default for FileTimes {
    fn default() -> Self {
        Self {
            created: None,
            modified: UNIX_EPOCH,
        }
    }
}

/// Вход проекции документа с известными метками времени.
#[derive(Debug, Clone, Copy)]
pub struct DocumentInput<'a> {
    pub path: &'a str,
    pub source: &'a str,
    pub times: FileTimes,
}

/// Источник диаграммы, прочитанный вызывающим кодом.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetRead {
    pub source: String,
    pub modified: SystemTime,
    pub version: Option<String>,
}

pub(crate) fn iso8601(time: SystemTime) -> String {
    // Date обрезает дробные миллисекунды к нулю.
    let millis = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(error) => i64::try_from(error.duration().as_millis())
            .unwrap_or(i64::MAX)
            .saturating_neg(),
    };
    jiff::Timestamp::from_millisecond(millis).map_or_else(
        |_| "1970-01-01T00:00:00.000Z".to_owned(),
        |timestamp| format!("{timestamp:.3}"),
    )
}
