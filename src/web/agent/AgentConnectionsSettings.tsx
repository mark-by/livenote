import { useEffect, useState } from 'react';
import { Alert, Button, Description, Input, Label, TextField } from '@heroui/react';
import type { AgentConnection, AgentProfile, AgentSecretChange, AgentSlot } from '../../shared/types';
import { beginAgentOauth, listAgentConnections, putAgentConnection } from './agentApi';
import { agentFault } from './agentFault';

interface ConnectionDraft {
  readonly baseUrl: string;
  readonly model: string;
  readonly endpoint: string;
  readonly resourceHost: string;
  readonly token: string;
  readonly clientId: string;
}

const slots = ['model', 'confluence', 'gitlab', 'github'] as const;
const titles: Readonly<Record<AgentSlot, string>> = { model: 'Модель', confluence: 'Confluence', gitlab: 'GitLab', github: 'GitHub' };
const states: Readonly<Record<AgentConnection['state'], string>> = {
  missing: 'Секрет не задан', ready: 'Подключено', expired: 'Требуется новый вход', unsupported: 'Сервер не поддерживается'
};
const emptyDraft: ConnectionDraft = { baseUrl: '', model: '', endpoint: '', resourceHost: '', token: '', clientId: '' };

function draftOf(connection: AgentConnection): ConnectionDraft {
  return {
    ...emptyDraft,
    baseUrl: connection.profile.kind === 'model' ? connection.profile.baseUrl : '',
    model: connection.profile.kind === 'model' ? connection.profile.model : '',
    endpoint: connection.profile.kind === 'model' ? '' : connection.profile.endpoint,
    resourceHost: connection.profile.kind === 'model' ? '' : connection.profile.resourceHost
  };
}

function profileOf(slot: AgentSlot, draft: ConnectionDraft): AgentProfile {
  return slot === 'model'
    ? { kind: 'model', baseUrl: draft.baseUrl.trim(), model: draft.model.trim() }
    : { kind: slot, endpoint: draft.endpoint.trim(), resourceHost: draft.resourceHost.trim() };
}

export function AgentConnectionsSettings({ vaultId }: { readonly vaultId: string }): React.JSX.Element {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [drafts, setDrafts] = useState<Readonly<Record<string, ConnectionDraft>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<AgentSlot | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    setReady(false);
    setLoadError(null);
    void listAgentConnections(vaultId).then(fresh => {
      if (!active) return;
      setConnections(fresh);
      setDrafts(Object.fromEntries(fresh.map(connection => [connection.profile.kind, draftOf(connection)])));
      setReady(true);
    }).catch((loadFailure: unknown) => {
      if (active) setLoadError(agentFault(loadFailure).message);
    });
    return () => { active = false; };
  }, [vaultId]);

  const update = (slot: AgentSlot, field: keyof ConnectionDraft, value: string): void => {
    setDrafts(current => ({ ...current, [slot]: { ...(current[slot] ?? emptyDraft), [field]: value } }));
  };
  const save = async (slot: AgentSlot, secret: AgentSecretChange, oauth: boolean): Promise<void> => {
    const draft = drafts[slot] ?? emptyDraft;
    setPending(slot);
    setErrors(current => ({ ...current, [slot]: '' }));
    try {
      const connection = await putAgentConnection(vaultId, profileOf(slot, draft), secret);
      setConnections(current => [...current.filter(item => item.profile.kind !== slot), connection]);
      setDrafts(current => ({ ...current, [slot]: { ...(current[slot] ?? emptyDraft), token: '' } }));
      if (oauth && slot !== 'model') await beginAgentOauth(vaultId, slot);
    } catch (saveError) {
      setErrors(current => ({ ...current, [slot]: agentFault(saveError).message }));
    } finally { setPending(null); }
  };

  return <section className="agent-connections" aria-label="Подключения агента">
    <h3>Подключения агента</h3>
    {loadError && <Alert status="danger" role="alert"><Alert.Content><Alert.Description>{loadError}</Alert.Description></Alert.Content></Alert>}
    {!ready && loadError === null && <p>Загрузка подключений…</p>}
    {ready && slots.map(slot => {
      const connection = connections.find(item => item.profile.kind === slot);
      const draft = drafts[slot] ?? emptyDraft;
      const error = errors[slot];
      const state = connection?.state ?? 'missing';
      return <section className="agent-connection" aria-label={titles[slot]} key={slot}>
        <div className="agent-connection__heading"><h4>{titles[slot]}</h4><span>{states[state]}</span></div>
        {slot === 'model' ? <>
          <TextField>
            <Label>Base URL</Label>
            <Input value={draft.baseUrl} onChange={event => update(slot, 'baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" />
            <Description>Базовый URL OpenAI-совместимого API без <code>/chat/completions</code>. Для удалённого сервера нужен HTTPS.</Description>
          </TextField>
          <TextField>
            <Label>Модель</Label>
            <Input value={draft.model} onChange={event => update(slot, 'model', event.target.value)} />
            <Description>Укажите идентификатор модели в API. Модель должна возвращать вызовы инструментов в <code>tool_calls</code>, а не в тексте ответа.</Description>
          </TextField>
        </> : <>
          <TextField><Label>MCP endpoint</Label><Input value={draft.endpoint} onChange={event => update(slot, 'endpoint', event.target.value)} placeholder="https://mcp.example/mcp" /></TextField>
          <TextField><Label>Resource host</Label><Input value={draft.resourceHost} onChange={event => update(slot, 'resourceHost', event.target.value)} placeholder="code.example" /></TextField>
        </>}
        <TextField>
          <Label>Токен</Label>
          <Input type="password" autoComplete="off" value={draft.token} onChange={event => update(slot, 'token', event.target.value)}
            placeholder={slot === 'model' ? 'Ключ API' : state === 'missing' ? 'Введите токен' : 'Оставьте пустым, чтобы сохранить текущий'} />
          {slot === 'model' && <Description>Введите ключ API. Пустое поле сохраняет прежний ключ только при неизменном Base URL.</Description>}
        </TextField>
        {slot !== 'model' && <TextField><Label>OAuth client ID</Label><Input value={draft.clientId} onChange={event => update(slot, 'clientId', event.target.value)} /></TextField>}
        <div className="agent-connection__actions">
          <Button size="sm" variant="secondary" isPending={pending === slot} onPress={() => void save(slot, draft.token === '' ? { kind: 'keep' } : { kind: 'token', value: draft.token }, false)}>Сохранить подключение</Button>
          <Button size="sm" variant="ghost" isDisabled={pending !== null} onPress={() => void save(slot, { kind: 'clear' }, false)}>Удалить секрет</Button>
          {slot !== 'model' && <Button size="sm" variant="outline" isDisabled={pending !== null || draft.clientId.trim() === ''} onPress={() => void save(slot, { kind: 'oauth', clientId: draft.clientId.trim() }, true)}>Войти через браузер</Button>}
        </div>
        <p className="agent-connection__note">{slot === 'model'
          ? 'LiveNote не показывает сохранённый ключ. Статус «Подключено» означает, что ключ сохранён, а не что модель проверена.'
          : 'Секрет не показывается в форме и не передаётся модели.'}</p>
        {error && <Alert status="danger" role="alert"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert>}
      </section>;
    })}
  </section>;
}
