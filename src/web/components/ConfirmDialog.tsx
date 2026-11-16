/**
 * Модальное окно подтверждения — замена нативного window.confirm.
 *
 * Использование через хук useConfirm:
 *   const { confirm, dialog } = useConfirm();
 *   const ok = await confirm({ title: 'Удалить страницу', message: '…', danger: true });
 *   if (!ok) return;
 *   ... // dialog рендерится рядом с корнем компонента
 *
 * Esc и «Отмена» — безопасный исход: промис разрешается false,
 * фокус по умолчанию стоит на «Отмене» (деструктивное действие — не по Enter).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Подпись подтверждающей кнопки; по умолчанию «Подтвердить». */
  confirmLabel?: string;
  /** Деструктивное действие: кнопка подтверждения — красная. */
  danger?: boolean;
}

interface PendingRequest {
  options: ConfirmOptions;
  resolve(result: boolean): void;
}

export function useConfirm(): { confirm(options: ConfirmOptions): Promise<boolean>; dialog: ReactNode } {
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const requestRef = useRef<PendingRequest | null>(null);
  requestRef.current = request;

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setRequest({ options, resolve });
    });
  }, []);

  // Компонент размонтировался при открытом окне — не оставляем висящих промисов.
  useEffect(() => {
    return () => {
      requestRef.current?.resolve(false);
    };
  }, []);

  const settle = (result: boolean): void => {
    requestRef.current?.resolve(result);
    setRequest(null);
  };

  const dialog =
    request === null ? null : (
      <ConfirmDialog
        options={request.options}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    );

  return { confirm, dialog };
}

interface ConfirmDialogProps {
  options: ConfirmOptions;
  onConfirm(): void;
  onCancel(): void;
}

function ConfirmDialog({ options, onConfirm, onCancel }: ConfirmDialogProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Фокус на безопасной кнопке («Отмена») при открытии.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Esc = отмена.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={options.title}>
      <div className="modal">
        <h2 className="modal__title">{options.title}</h2>
        <p className="modal__text">{options.message}</p>
        <div className="modal__actions">
          <button ref={cancelRef} className="btn" type="button" onClick={onCancel}>
            Отмена
          </button>
          <button
            className={`btn ${options.danger === true ? 'btn--danger' : 'btn--primary'}`}
            type="button"
            onClick={onConfirm}
          >
            {options.confirmLabel ?? 'Подтвердить'}
          </button>
        </div>
      </div>
    </div>
  );
}
