import { useEffect, useState } from 'react';
import { Alert, Button, Input, Label, ListBox, Modal, TextField } from '@heroui/react';
import type { VaultProblem, VaultSnapshot } from '../../shared/types';

export function VaultPathDialog({ open, title, label, initialPath, confirmLabel, onOpenChange, onSubmit }: {
  readonly open: boolean;
  readonly title: string;
  readonly label: string;
  readonly initialPath: string;
  readonly confirmLabel: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (path: string) => Promise<string | null>;
}): React.JSX.Element {
  const [path, setPath] = useState(initialPath);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setPath(initialPath); setError(null); } }, [initialPath, open]);
  const submit = async (): Promise<void> => {
    if (!path.trim() || pending) return;
    setPending(true); setError(null);
    try { const result = await onSubmit(path.trim()); if (result) setError(result); else onOpenChange(false); }
    finally { setPending(false); }
  };
  return <Modal.Backdrop isOpen={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <Modal.Container><Modal.Dialog aria-label={title}>
      <Modal.Header><Modal.Heading>{title}</Modal.Heading><Modal.CloseTrigger aria-label="Закрыть" /></Modal.Header>
      <Modal.Body><TextField fullWidth autoFocus value={path} onChange={setPath}><Label>{label}</Label><Input aria-label={label} /></TextField>
        {error && <Alert color="danger" role="alert"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert>}</Modal.Body>
      <Modal.Footer><Button slot="close" variant="ghost" isDisabled={pending}>Отмена</Button><Button variant="primary" isDisabled={!path.trim() || pending} onPress={() => void submit()}>{pending ? 'Сохранение…' : confirmLabel}</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}

export function AssetPickerDialog({ open, files, onOpenChange, onChoose }: {
  readonly open: boolean;
  readonly files: VaultSnapshot['files'];
  readonly onOpenChange: (open: boolean) => void;
  readonly onChoose: (path: string) => void;
}): React.JSX.Element {
  const assets = files.filter((file) => file.kind !== 'markdown');
  return <Modal.Backdrop isOpen={open} onOpenChange={onOpenChange}>
    <Modal.Container><Modal.Dialog aria-label="Выбрать файл схемы">
      <Modal.Header><Modal.Heading>Существующая схема</Modal.Heading><Modal.CloseTrigger aria-label="Закрыть" /></Modal.Header>
      <Modal.Body>{assets.length === 0 ? <p className="vault-empty">В хранилище пока нет отдельных файлов схем.</p> : <ListBox aria-label="Файлы схем" onAction={(key) => { onChoose(key.toString()); onOpenChange(false); }}>
        {assets.map((file) => <ListBox.Item id={file.path} key={file.path} textValue={file.path}>{file.path}</ListBox.Item>)}
      </ListBox>}</Modal.Body>
      <Modal.Footer><Button slot="close" variant="ghost">Отмена</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}

const PROBLEM_LABELS: Record<VaultProblem['code'], string> = {
  missing_id: 'Устаревшие метаданные', invalid_frontmatter: 'Ошибка YAML frontmatter', duplicate_page_id: 'Дублируется устаревший id',
  invalid_block: 'Ошибка структуры блока', duplicate_block_id: 'Дублируется id блока', missing_asset: 'Не найден файл схемы',
  unsafe_path: 'Небезопасный путь', git_conflict: 'Конфликт слияния Git', unreadable_file: 'Файл не читается'
};

export function DiagnosticsDialog({ problems, open, onOpenChange }: {
  readonly problems: VaultProblem[]; readonly open: boolean; readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return <Modal.Backdrop isOpen={open} onOpenChange={onOpenChange}><Modal.Container><Modal.Dialog aria-label="Диагностика хранилища">
    <Modal.Header><Modal.Heading>Диагностика хранилища</Modal.Heading><Modal.CloseTrigger aria-label="Закрыть" /></Modal.Header>
    <Modal.Body><div className="vault-diagnostics">{problems.map((problem, index) => <section key={`${problem.path}-${index}`}>
      <strong>{PROBLEM_LABELS[problem.code]}</strong><code>{problem.path}</code><p>{problem.message}</p>
    </section>)}</div></Modal.Body><Modal.Footer><Button slot="close" variant="primary">Понятно</Button></Modal.Footer>
  </Modal.Dialog></Modal.Container></Modal.Backdrop>;
}
