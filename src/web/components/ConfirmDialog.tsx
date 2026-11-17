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
import { Button, Modal } from '@heroui/react';
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
  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open) onCancel(); }}>
      <Modal.Container>
        <Modal.Dialog aria-label={options.title}>
          <Modal.Header><Modal.Heading>{options.title}</Modal.Heading></Modal.Header>
          <Modal.Body><p className="modal__text">{options.message}</p></Modal.Body>
          <Modal.Footer>
            <Button autoFocus variant="ghost" onPress={onCancel}>Отмена</Button>
            <Button variant={options.danger === true ? 'danger' : 'primary'} onPress={onConfirm}>
              {options.confirmLabel ?? 'Подтвердить'}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
