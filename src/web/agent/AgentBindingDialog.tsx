import { useEffect, useState } from 'react';
import { Alert, Button, Input, Label, ListBox, Modal, Select, TextField } from '@heroui/react';
import type { AgentBindingView, AgentRepo } from '../../shared/types';
import { getAgentBinding, pickAgentBindingFolder, putAgentBinding } from './agentApi';
import { agentFault } from './agentFault';

interface AgentBindingDialogProps {
  readonly vaultId: string;
  readonly folder: string;
  readonly onClose: () => void;
}

export function AgentBindingDialog({ vaultId, folder, onClose }: AgentBindingDialogProps): React.JSX.Element {
  const [binding, setBinding] = useState<AgentBindingView | null>(null);
  const [provider, setProvider] = useState<AgentRepo['provider']>('gitlab');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [localDir, setLocalDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'load' | 'pick' | 'save' | null>('load');

  useEffect(() => {
    let active = true;
    void getAgentBinding(vaultId, folder).then(fresh => {
      if (!active) return;
      setBinding(fresh);
      setProvider(fresh.value.repo?.provider ?? 'gitlab');
      setUrl(fresh.value.repo?.url ?? '');
      setRef(fresh.value.repo?.ref ?? '');
      setLocalDir(fresh.value.localDir ?? '');
      setPending(null);
    }).catch((loadError: unknown) => {
      if (active) {
        setError(agentFault(loadError).message);
        setPending(null);
      }
    });
    return () => { active = false; };
  }, [folder, vaultId]);

  const save = async (remove: boolean): Promise<void> => {
    if (binding === null) return;
    setPending('save');
    setError(null);
    const trimmedUrl = url.trim();
    const trimmedRef = ref.trim();
    const repo = remove || trimmedUrl === '' ? null : {
      provider, url: trimmedUrl, ...(trimmedRef === '' ? {} : { ref: trimmedRef })
    };
    try {
      await putAgentBinding(vaultId, {
        folder, version: binding.version,
        value: { repo, localDir: remove || localDir.trim() === '' ? null : localDir.trim() }
      });
      onClose();
    } catch (saveError) { setError(agentFault(saveError).message); }
    finally { setPending(null); }
  };

  return <Modal.Backdrop isOpen onOpenChange={open => { if (!open && pending !== 'save') onClose(); }}>
    <Modal.Container><Modal.Dialog aria-label="Привязка исходников">
      <Modal.Header><Modal.Heading>Привязка исходников</Modal.Heading><Modal.CloseTrigger aria-label="Закрыть привязку" /></Modal.Header>
      <Modal.Body><div className="vault-dialog-fields">
        <p className="agent-binding__folder">Папка: {folder === '' ? 'корень хранилища' : folder}</p>
        {pending === 'load' && <p>Загрузка привязки…</p>}
        {binding && <>
          <Select value={provider} onChange={value => setProvider(String(value) === 'github' ? 'github' : 'gitlab')}>
            <Label>Провайдер</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover><ListBox>
              <ListBox.Item id="gitlab" textValue="GitLab">GitLab<ListBox.ItemIndicator /></ListBox.Item>
              <ListBox.Item id="github" textValue="GitHub">GitHub<ListBox.ItemIndicator /></ListBox.Item>
            </ListBox></Select.Popover>
          </Select>
          <TextField><Label>URL репозитория</Label><Input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://git.example/team/service.git" /></TextField>
          <TextField><Label>Ветка или ревизия</Label><Input value={ref} onChange={event => setRef(event.target.value)} placeholder="main" /></TextField>
          <div className="agent-binding__local">
            <TextField><Label>Локальная директория</Label><Input value={localDir} readOnly placeholder="Каталог не выбран" /></TextField>
            <Button variant="secondary" isPending={pending === 'pick'} onPress={() => {
              setPending('pick');
              setError(null);
              void pickAgentBindingFolder(vaultId).then(result => {
                if (result.localDir !== null) setLocalDir(result.localDir);
              }).catch((pickError: unknown) => setError(agentFault(pickError).message)).finally(() => setPending(null));
            }}>Выбрать папку</Button>
          </div>
          <p className="agent-connection__note">Локальный путь остаётся на этом компьютере. В Git сохраняется только репозиторий.</p>
        </>}
        {error && <Alert status="danger" role="alert"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert>}
      </div></Modal.Body>
      <Modal.Footer><div className="agent-binding__actions">
        {binding !== null && (binding.value.repo !== null || binding.value.localDir !== null) && <Button variant="danger-soft" isDisabled={pending !== null} onPress={() => void save(true)}>Удалить привязку</Button>}
        <Button variant="ghost" isDisabled={pending === 'save'} onPress={onClose}>Отмена</Button>
        <Button variant="primary" isPending={pending === 'save'} isDisabled={binding === null || pending === 'pick'} onPress={() => void save(false)}>Сохранить привязку</Button>
      </div></Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}
