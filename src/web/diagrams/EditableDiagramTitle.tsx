import { useId, useRef, useState } from 'react';
import { Button, Input } from '@heroui/react';

interface EditableDiagramTitleProps {
  readonly title: string;
  readonly onRename: (title: string, focusEditor: boolean) => string | undefined;
}

export function EditableDiagramTitle({ title, onRename }: EditableDiagramTitleProps): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const finished = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const errorId = useId();

  function close(restoreFocus: boolean) {
    finished.current = true;
    setDraft(null);
    setError(undefined);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }

  function save(value: string, restoreFocus: boolean) {
    if (finished.current) return;
    const next = value.trim();
    if (next === title) { close(restoreFocus); return; }
    finished.current = true;
    const message = next ? onRename(next, restoreFocus) : 'Введите название схемы.';
    if (message) {
      finished.current = false;
      setError(message);
    } else close(false);
  }

  return <div className="diagram-title diagram-adapter__title">
    {draft === null ? <Button ref={trigger} variant="ghost" className="diagram-adapter__title-trigger"
      onPress={() => { finished.current = false; setDraft(title); }}>
      {title || 'Схема'}
    </Button> : <>
      <Input aria-label="Название схемы" aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        className="diagram-adapter__title-input" value={draft} placeholder="Схема" autoFocus
        onFocus={event => event.currentTarget.select()}
        onChange={event => { setDraft(event.currentTarget.value); setError(undefined); }}
        onBlur={event => save(event.currentTarget.value, false)}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            close(true);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            save(event.currentTarget.value, true);
          }
        }} />
      {error && <div id={errorId} className="diagram-adapter__title-error" role="alert">{error}</div>}
    </>}
  </div>;
}
