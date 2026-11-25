import { useEffect, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { Alert, Button, Chip, Description, Input, Label, Separator, Surface, Tabs, TextField } from '@heroui/react';
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
type Integration = Exclude<AgentSlot, 'model'>;
type Operation = 'save' | 'clear' | 'oauth';
type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly connections: readonly AgentConnection[] };

const integrations = [
  { id: 'confluence', label: 'Confluence' }, { id: 'gitlab', label: 'GitLab' }, { id: 'github', label: 'GitHub' }
] as const;
const titles: Readonly<Record<AgentSlot, string>> = { model: 'Модель', confluence: 'Confluence', gitlab: 'GitLab', github: 'GitHub' };
const states = {
  missing: { label: 'Секрет не задан', color: 'default' },
  ready: { label: 'Подключено', color: 'success' },
  expired: { label: 'Требуется новый вход', color: 'warning' },
  unsupported: { label: 'Сервер не поддерживается', color: 'danger' }
} as const satisfies Record<AgentConnection['state'], { readonly label: string; readonly color: ComponentProps<typeof Chip>['color'] }>;

const emptyDraft: ConnectionDraft = { baseUrl: '', model: '', endpoint: '', resourceHost: '', token: '', clientId: '' };

function draftOf({ profile }: AgentConnection): ConnectionDraft {
  return profile.kind === 'model'
    ? { ...emptyDraft, baseUrl: profile.baseUrl, model: profile.model }
    : { ...emptyDraft, endpoint: profile.endpoint, resourceHost: profile.resourceHost };
}

function profileOf(slot: AgentSlot, draft: ConnectionDraft): AgentProfile {
  return slot === 'model'
    ? { kind: 'model', baseUrl: draft.baseUrl.trim(), model: draft.model.trim() }
    : { kind: slot, endpoint: draft.endpoint.trim(), resourceHost: draft.resourceHost.trim() };
}

function secretOf(action: Operation, draft: ConnectionDraft): AgentSecretChange {
  switch (action) {
    case 'save': return draft.token === '' ? { kind: 'keep' } : { kind: 'token', value: draft.token };
    case 'clear': return { kind: 'clear' };
    case 'oauth': return { kind: 'oauth', clientId: draft.clientId.trim() };
  }
}

/** Состояние живёт в диалоге, а не во вкладке: переключение разделов не трогает черновики. */
export function useAgentConnectionsSettings(vaultId: string | undefined, visible: boolean) {
  const [requested, setRequested] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [drafts, setDrafts] = useState<Partial<Record<AgentSlot, ConnectionDraft>>>({});
  const [errors, setErrors] = useState<Partial<Record<AgentSlot, string>>>({});
  const [pending, setPending] = useState<{ readonly slot: AgentSlot; readonly action: Operation } | null>(null);
  const busy = useRef(false);

  useEffect(() => { if (visible) setRequested(true); }, [visible]);
  useEffect(() => {
    if (!vaultId || !requested) return;
    let active = true;
    void listAgentConnections(vaultId).then(connections => {
      if (!active) return;
      setDrafts(Object.fromEntries(connections.map(connection => [connection.profile.kind, draftOf(connection)])));
      setLoad({ kind: 'ready', connections });
    }).catch((error: unknown) => {
      if (active) setLoad({ kind: 'error', message: agentFault(error).message });
    });
    return () => { active = false; };
  }, [vaultId, requested, attempt]);

  const retry = (): void => {
    setLoad({ kind: 'loading' });
    setAttempt(value => value + 1);
  };
  const update = (slot: AgentSlot, field: keyof ConnectionDraft, value: string): void => {
    setDrafts(current => ({ ...current, [slot]: { ...(current[slot] ?? emptyDraft), [field]: value } }));
  };
  const save = async (slot: AgentSlot, action: Operation): Promise<void> => {
    if (!vaultId || busy.current || load.kind !== 'ready') return;
    const draft = drafts[slot] ?? emptyDraft;
    if (action === 'oauth' && (slot === 'model' || !draft.clientId.trim())) return;
    busy.current = true;
    setPending({ slot, action });
    setErrors(current => ({ ...current, [slot]: '' }));
    try {
      const connection = await putAgentConnection(vaultId, profileOf(slot, draft), secretOf(action, draft));
      setLoad(current => current.kind === 'ready'
        ? { kind: 'ready', connections: [...current.connections.filter(item => item.profile.kind !== slot), connection] }
        : current);
      setDrafts(current => ({ ...current, [slot]: { ...draftOf(connection), clientId: draft.clientId } }));
      if (action === 'oauth' && slot !== 'model') await beginAgentOauth(vaultId, slot);
    } catch (error: unknown) {
      setErrors(current => ({ ...current, [slot]: agentFault(error).message }));
    } finally {
      busy.current = false;
      setPending(null);
    }
  };
  return { load, pending, drafts, errors, retry, update, save };
}

type Controller = ReturnType<typeof useAgentConnectionsSettings>;

export function AgentConnectionsSettings({ section, controller, integration, onIntegrationChange }: {
  readonly section: 'model' | 'integrations';
  readonly controller: Controller;
  readonly integration: Integration;
  readonly onIntegrationChange: (integration: Integration) => void;
}): React.JSX.Element {
  if (section === 'model') return <ConnectionPanel slot="model" controller={controller} />;
  return <Tabs selectedKey={integration} keyboardActivation="manual" onSelectionChange={key => {
    const next = integrations.find(item => item.id === key);
    if (next) onIntegrationChange(next.id);
  }} className="min-w-0">
    <Tabs.ListContainer className="w-fit max-w-full">
      <Tabs.List aria-label="Интеграции" className="max-w-full">
        {integrations.map(item => <Tabs.Tab id={item.id} key={item.id} className="h-10 min-w-0 px-2 min-[50rem]:h-8 min-[50rem]:px-4">
          {item.label}<Tabs.Indicator />
        </Tabs.Tab>)}
      </Tabs.List>
    </Tabs.ListContainer>
    {integrations.map(item => <Tabs.Panel id={item.id} key={item.id} className="px-0! pt-4">
      {integration === item.id && <ConnectionPanel slot={item.id} controller={controller} />}
    </Tabs.Panel>)}
  </Tabs>;
}

function ConnectionPanel({ slot, controller }: { readonly slot: AgentSlot; readonly controller: Controller }): React.JSX.Element {
  const { load, pending, drafts, errors, retry, update, save } = controller;
  if (load.kind === 'loading') return <Surface variant="secondary" className="rounded-2xl px-5 py-4">
    <p role="status" className="text-sm text-muted">Загрузка подключений…</p>
  </Surface>;
  if (load.kind === 'error') return <Surface variant="secondary" className="grid justify-items-start gap-3 rounded-2xl p-5">
    <Alert status="danger" role="alert"><Alert.Content><Alert.Description>{load.message}</Alert.Description></Alert.Content></Alert>
    <Button variant="secondary" onPress={retry}>Повторить загрузку</Button>
  </Surface>;

  const draft = drafts[slot] ?? emptyDraft;
  const error = errors[slot];
  const state = load.connections.find(item => item.profile.kind === slot)?.state ?? 'missing';
  const busyHere = pending?.slot === slot;
  const name = titles[slot];
  const field = (key: keyof ConnectionDraft, label: string, help?: ReactNode, placeholder?: string): React.JSX.Element =>
    <TextField className={`min-w-0 gap-2 ${key === 'token' && slot === 'model' ? 'min-[50rem]:col-span-2' : ''}`}
      value={draft[key]} onChange={value => update(slot, key, value)} isDisabled={busyHere}>
      <Label className="font-semibold">{label}</Label>
      <Input variant="secondary" className="min-h-10 w-full min-w-0 border border-separator-tertiary max-[49.999rem]:min-h-11"
        placeholder={placeholder} type={key === 'token' ? 'password' : 'text'} autoComplete={key === 'token' ? 'off' : undefined} />
      {help && <Description className="leading-relaxed">{help}</Description>}
    </TextField>;
  const actionClass = 'min-h-11 max-w-full whitespace-normal min-[50rem]:min-h-9';
  return <Surface variant="secondary" className="rounded-2xl p-5">
    <section aria-label={name} className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{slot === 'model' ? 'Подключение модели' : `Подключение ${name}`}</h3>
        <span role="status"><Chip color={states[state].color} variant="soft"><Chip.Label>{states[state].label}</Chip.Label></Chip></span>
      </div>
      <Separator className="h-px bg-separator-secondary" />
      <div className="grid min-w-0 gap-4 min-[50rem]:grid-cols-2">
        {slot === 'model' ? <>
          {field('baseUrl', 'Base URL', <>Без <code>/chat/completions</code>. Для удалённого сервера нужен HTTPS.</>, 'https://api.openai.com/v1')}
          {field('model', 'Модель', <>Модель должна возвращать вызовы инструментов в <code>tool_calls</code>, а не в тексте.</>, 'Идентификатор модели')}
          {field('token', 'Токен', 'Пустое поле сохраняет прежний ключ только при неизменном Base URL.', 'Ключ API')}
        </> : <>
          {field('endpoint', 'MCP endpoint', undefined, 'https://mcp.example/mcp')}
          {field('resourceHost', 'Resource host', undefined, 'code.example')}
          {field('token', 'Токен', undefined, state === 'missing' ? 'Введите токен' : 'Оставьте пустым, чтобы сохранить текущий')}
          {field('clientId', 'OAuth client ID')}
        </>}
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button className={actionClass} variant="primary" isPending={busyHere && pending.action === 'save'}
          isDisabled={pending !== null && !(busyHere && pending.action === 'save')}
          onPress={() => void save(slot, 'save')}>Сохранить подключение</Button>
        {slot !== 'model' && <Button className={actionClass} variant="outline" isPending={busyHere && pending.action === 'oauth'}
          isDisabled={(pending !== null && !(busyHere && pending.action === 'oauth')) || !draft.clientId.trim()}
          onPress={() => void save(slot, 'oauth')}>Войти через браузер</Button>}
        <Button className={actionClass} variant="danger-soft" isPending={busyHere && pending.action === 'clear'}
          isDisabled={pending !== null && !(busyHere && pending.action === 'clear')}
          onPress={() => void save(slot, 'clear')}>Удалить секрет</Button>
      </div>
      <p className="text-sm leading-relaxed text-muted">{slot === 'model'
        ? 'LiveNote не показывает сохранённый ключ. Статус «Подключено» означает, что ключ сохранён, а не что модель проверена.'
        : 'Секрет не показывается в форме и не передаётся модели.'}</p>
      {error && <Alert status="danger" role="alert"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert>}
    </section>
  </Surface>;
}
