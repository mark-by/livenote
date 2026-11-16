/**
 * Панель действий блока: Копировать / Редактировать / Вверх / Вниз / Удалить.
 * Появляется при наведении на карточку блока (см. styles.css).
 */
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
      <button type="button" className="block-action" onClick={onEdit} title="Редактировать">
        Редактировать
      </button>
      <button
        type="button"
        className="block-action"
        onClick={onMoveUp}
        disabled={!canMoveUp}
        title="Переместить вверх"
      >
        ↑ Вверх
      </button>
      <button
        type="button"
        className="block-action"
        onClick={onMoveDown}
        disabled={!canMoveDown}
        title="Переместить вниз"
      >
        ↓ Вниз
      </button>
      <button type="button" className="block-action block-action--danger" onClick={onDelete} title="Удалить блок">
        Удалить
      </button>
    </div>
  );
}
