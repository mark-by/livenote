/**
 * Панель действий блока: Копировать / Редактировать / Вверх / Вниз / Удалить.
 * Появляется при наведении на карточку блока (см. styles.css).
 */
import { Button } from '@heroui/react';
import { CopyButton } from './CopyButton';

interface BlockActionsProps {
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Исходник блока для копирования в буфер обмена. */
  copyText: string;
  onEdit(): void;
  onMoveUp(): void;
  onMoveDown(): void;
  onDelete(): void;
}

export function BlockActions({
  canMoveUp,
  canMoveDown,
  copyText,
  onEdit,
  onMoveUp,
  onMoveDown,
  onDelete
}: BlockActionsProps): React.JSX.Element {
  return (
    <div className="block__actions" onClick={(event) => event.stopPropagation()}>
      <CopyButton text={copyText} title="Копировать" className="block-action" />
      <Button variant="ghost" size="sm" className="block-action" onPress={onEdit}>
        Редактировать
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="block-action"
        onPress={onMoveUp}
        isDisabled={!canMoveUp}
      >
        ↑ Вверх
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="block-action"
        onPress={onMoveDown}
        isDisabled={!canMoveDown}
      >
        ↓ Вниз
      </Button>
      <Button variant="danger-soft" size="sm" className="block-action block-action--danger" onPress={onDelete}>
        Удалить
      </Button>
    </div>
  );
}
