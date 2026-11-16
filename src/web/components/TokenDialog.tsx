/**
 * Модальное окно ввода bearer-токена.
 * Показывается, когда сервер требует токен (tokenRequired) или токен оказался неверным.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

interface TokenDialogProps {
  onConfirm(token: string): void;
}

export function TokenDialog({ onConfirm }: TokenDialogProps): React.JSX.Element {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Автофокус на поле ввода при открытии.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const token = value.trim();
    if (token.length > 0) {
      onConfirm(token);
    }
  };

  return (
    <div className="modal-overlay">
      <form className="modal" onSubmit={handleSubmit}>
        <h2 className="modal__title">LiveNote защищён токеном</h2>
        <p className="modal__text">
          Сервер требует bearer-токен. Введите его — он сохранится локально в браузере.
        </p>
        <input
          ref={inputRef}
          className="modal__input"
          type="password"
          placeholder="Токен"
          value={value}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="modal__actions">
          <button className="btn btn--primary" type="submit" disabled={value.trim().length === 0}>
            Открыть
          </button>
        </div>
      </form>
    </div>
  );
}
