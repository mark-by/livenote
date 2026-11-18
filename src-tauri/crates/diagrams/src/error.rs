use thiserror::Error;

/// Сбой запуска Chromium или обмена данными с ним.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum DiagramError {
    #[error("Ошибка ввода-вывода Chromium: {0}")]
    Io(#[from] std::io::Error),
    #[error("Ошибка формата CDP: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Chromium закрыл канал CDP")]
    Disconnected,
    #[error("Недопустимый размер или идентификатор сообщения CDP")]
    InvalidFrame,
    #[error("Ошибка Chromium CDP: {0}")]
    Protocol(String),
    #[error("Не удалось загрузить обработчик диаграмм: {0}")]
    Worker(String),
    #[error("Истекло время работы Chromium")]
    Timeout,
}
