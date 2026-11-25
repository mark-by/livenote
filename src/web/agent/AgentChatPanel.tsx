import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button, CloseButton, Label, ListBox, ProgressCircle, Select, Switch, TextArea, Tooltip } from '@heroui/react';
import { ArrowUp, Gear, Plus } from '@gravity-ui/icons';
import type { AgentChat } from './useAgentChat';
import type { AgentWorkspace } from './agentWorkspace';
import { agentFaultText, AgentTurnView } from './AgentTurnView';

interface AgentChatPanelProps {
  readonly chat: AgentChat;
  readonly workspace: AgentWorkspace;
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

export function AgentChatPanel({ chat, workspace, onClose, onOpenSettings }: AgentChatPanelProps): React.JSX.Element {
  const composerId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const turns = chat.details?.turns ?? [];
  const latestTurn = turns.at(-1);
  const contentKey = `${chat.selectedId}:${turns.length}:${latestTurn?.status ?? ''}:${JSON.stringify(latestTurn?.progress ?? null)}`;
  useLayoutEffect(() => {
    if (pinned) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' });
  }, [contentKey, pinned]);
  const send = (): void => { void chat.submit(); };
  const measured = turns.findLast(turn => {
    const progress = turn.progress;
    return progress !== undefined && Number.isFinite(progress.contextTokens) && progress.contextTokens >= 0
      && Number.isFinite(progress.contextLimitTokens) && progress.contextLimitTokens > 0;
  })?.progress;
  const contextTokens = measured?.contextTokens ?? 0;
  const contextLimitTokens = measured?.contextLimitTokens ?? chat.contextLimitTokens;
  const contextText = `${formatTokenCount(contextTokens)}/${formatTokenCount(contextLimitTokens)}`;
  const contextPercentage = Math.min(100, contextTokens / contextLimitTokens * 100);

  return <aside className="agent-chat" aria-label="Чат агента">
    <header className="agent-chat__header">
      <h2>Агент</h2>
      <div className="agent-chat__header-actions">
        <Tooltip><Button isIconOnly size="sm" variant="ghost" aria-label="Настройки агента" onPress={onOpenSettings}>
          <Gear aria-hidden="true" />
        </Button><Tooltip.Content>Настройки агента</Tooltip.Content></Tooltip>
        <Tooltip><CloseButton aria-label="Скрыть чат" onPress={onClose} /><Tooltip.Content>Скрыть чат</Tooltip.Content></Tooltip>
      </div>
    </header>
    <div className="agent-chat__sessions">
      <Select value={chat.selectedId} onChange={value => chat.setSelectedId(value === null ? null : String(value))}
        placeholder="Выберите разговор" isDisabled={chat.sessions.length === 0}>
        <Label className="sr-only">История разговоров</Label>
        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover><ListBox>
          {chat.sessions.map(session => <ListBox.Item key={session.id} id={session.id} textValue={session.title}>
            {session.title}<ListBox.ItemIndicator />
          </ListBox.Item>)}
        </ListBox></Select.Popover>
      </Select>
      <Tooltip><Button isIconOnly size="sm" variant="secondary" isPending={chat.creating} aria-label="Новый разговор"
        onPress={() => void chat.createSession()}><Plus aria-hidden="true" /></Button><Tooltip.Content>Новый разговор</Tooltip.Content></Tooltip>
    </div>
    <div className="agent-chat__follow">
      <Switch size="sm" isSelected={chat.followAgent} onChange={chat.setFollowAgent}>
        <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control>Следить за агентом</Switch.Content>
      </Switch>
    </div>
    <div className="agent-chat__conversation">
      <div className="agent-chat__messages" ref={scrollRef} onScroll={event => {
        const element = event.currentTarget;
        setPinned(element.scrollHeight - element.scrollTop - element.clientHeight <= 48);
      }}>
        {!chat.ready && <div className="agent-chat__empty"><p>Загрузка разговоров…</p></div>}
        {chat.ready && chat.sessions.length === 0 && <div className="agent-chat__empty">
          <h3>Начните разговор</h3>
          <p>Создайте разговор, чтобы задать вопрос по проекту.</p>
          <Button variant="secondary" onPress={() => void chat.createSession()}><Plus aria-hidden="true" />Новый разговор</Button>
        </div>}
        {chat.ready && chat.selectedId !== null && !chat.details && <div className="agent-chat__empty"><p>Загрузка сообщений…</p></div>}
        {chat.ready && chat.details && turns.length === 0 && <div className="agent-chat__empty">
          <h3>Спросите о проекте</h3>
          <p>Агент найдёт ответ в документах или исходниках и укажет источники.</p>
        </div>}
        {turns.map(turn => <AgentTurnView key={turn.id} turn={turn} workspace={workspace} />)}
      </div>
      {!pinned && <Button className="agent-chat__latest" size="sm" variant="secondary" onPress={() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
        setPinned(true);
      }}>К последнему сообщению</Button>}
    </div>
    {chat.error && <Alert status="danger" role="alert" className="agent-chat__error">
      <Alert.Content><Alert.Title>Действие не выполнено</Alert.Title><Alert.Description>{agentFaultText(chat.error)}</Alert.Description></Alert.Content>
      <Button size="sm" variant="ghost" onPress={chat.clearError}>Закрыть</Button>
    </Alert>}
    <form className="agent-chat__composer" onSubmit={event => { event.preventDefault(); send(); }}>
      <div className="agent-chat__composer-context">
        <Tooltip>
          <Tooltip.Trigger>
            <Button type="button" isIconOnly size="sm" variant="ghost" className="agent-chat__context-progress"
              data-testid="agent-context-progress" aria-label={`Контекст разговора: ${contextText}`}>
              <ProgressCircle size="sm" value={contextPercentage} aria-hidden="true">
                <ProgressCircle.Track>
                  <ProgressCircle.TrackCircle />
                  <ProgressCircle.FillCircle />
                </ProgressCircle.Track>
              </ProgressCircle>
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>{contextText}</Tooltip.Content>
        </Tooltip>
      </div>
      <Label className="sr-only" htmlFor={composerId}>Сообщение агенту</Label>
      <div className="agent-chat__composer-shell">
        <TextArea id={composerId} aria-label="Сообщение агенту" rows={3} variant="secondary" value={chat.draft}
          placeholder="Вопрос по проекту или открытой схеме" onChange={event => chat.setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }} />
        <div className="agent-chat__composer-footer">
          <Button type="submit" variant="primary" isIconOnly aria-label="Отправить" isPending={chat.submitting}
            isDisabled={chat.draft.trim() === '' || chat.selectedId === null || chat.running || chat.submitting}>
            <ArrowUp aria-hidden="true" />
          </Button>
        </div>
      </div>
    </form>
  </aside>;
}
