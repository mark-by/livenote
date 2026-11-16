/**
 * Ошибки приложения с машиночитаемым кодом.
 * REST-слой маппит их в HTTP-статусы, MCP-слой — в isError-результаты инструментов.
 */

export class AppError extends Error {
  constructor(
    /** Машиночитаемый код: not_found, conflict, invalid_request, unauthorized... */
    public readonly code: string,
    message: string,
    /** HTTP-статус для REST-ответа. */
    public readonly httpStatus: number = 400,
    /** Дополнительные данные: например currentRevision при конфликте. */
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Сущность не найдена (страница/блок). */
export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super('not_found', message, 404, details);
    this.name = 'NotFoundError';
  }
}

/** Ревизия страницы не совпала с ожидаемой — кто-то уже изменил её. */
export class ConflictError extends AppError {
  constructor(message: string, currentRevision: number) {
    super('conflict', message, 409, { currentRevision });
    this.name = 'ConflictError';
  }
}

/** Некорректный запрос: плохой ID, пустой source и т.п. */
export class InvalidRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super('invalid_request', message, 400, details);
    this.name = 'InvalidRequestError';
  }
}

/** Отсутствует или неверный bearer-токен. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Требуется bearer-токен (задайте переменную окружения LIVENOTE_TOKEN)') {
    super('unauthorized', message, 401);
    this.name = 'UnauthorizedError';
  }
}

/** Повторный request_id с другим телом запроса. */
export class IdempotencyKeyError extends AppError {
  constructor(message: string) {
    super('idempotency_key_reuse', message, 409);
    this.name = 'IdempotencyKeyError';
  }
}
