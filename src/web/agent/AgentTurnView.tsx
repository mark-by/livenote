import { Alert, Button, Disclosure } from '@heroui/react';
import type { AgentCite, AgentFault, AgentTurn } from '../../shared/types';
import type { AgentWorkspace } from './agentWorkspace';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentTurnActivity } from './AgentTurnActivity';
import { CopyButton } from '../components/CopyButton';

interface TurnViewProps {
  readonly turn: AgentTurn;
  readonly workspace: AgentWorkspace;
}

function faultText(fault: AgentFault): string {
  const paths = fault.details?.paths;
  return paths && paths.length > 0 ? `${fault.message} Пути: ${paths.join(', ')}` : fault.message;
}

function Citation({ cite, workspace }: { readonly cite: AgentCite; readonly workspace: AgentWorkspace }): React.JSX.Element {
  switch (cite.kind) {
    case 'vault':
      return <Button size="sm" variant="tertiary" className="agent-turn__cite" onPress={() => workspace.openPage(cite.path)}>{`${cite.path}:${cite.line}`}</Button>;
    case 'localCode':
      return <code className="agent-turn__local-cite">{`${cite.path}:${cite.line}`}</code>;
    case 'remoteCode':
      return <a href={cite.url} target="_blank" rel="noreferrer">{`${cite.path}:${cite.line}`}</a>;
    case 'confluence':
      return <a href={cite.url} target="_blank" rel="noreferrer">{cite.title}</a>;
  }
}

function ChangedFiles({ paths }: { readonly paths: readonly string[] }): React.JSX.Element {
  return <Disclosure className="agent-turn__changed">
    <Disclosure.Heading>
      <Button slot="trigger" size="sm" variant="ghost">
        Изменённые файлы <span className="agent-turn__count">{paths.length}</span><Disclosure.Indicator />
      </Button>
    </Disclosure.Heading>
    <Disclosure.Content><Disclosure.Body>
      <div className="agent-turn__changed-list">{paths.map(path => <code key={path}>{path}</code>)}</div>
    </Disclosure.Body></Disclosure.Content>
  </Disclosure>;
}

export function AgentTurnView({ turn, workspace }: TurnViewProps): React.JSX.Element {
  return <article className="agent-turn">
    <section className="agent-turn__user" aria-label="Сообщение пользователя">
      <span className="agent-turn__role">Вы</span>
      <div className="agent-turn__question">{turn.text}</div>
    </section>
    <section className="agent-turn__assistant" aria-label="Ответ агента">
      <div className="agent-turn__assistant-heading">
        <span className="agent-turn__role">Агент</span>
        {turn.status === 'done' && <CopyButton text={turn.answer} title="Копировать ответ" className="agent-turn__copy" />}
      </div>
      {(turn.status === 'running' || turn.progress) && <AgentTurnActivity progress={turn.progress} running={turn.status === 'running'} />}
      {turn.status === 'done' && <>
        <AgentMarkdown>{turn.answer}</AgentMarkdown>
        {turn.cites.length > 0 && <section className="agent-turn__cites" aria-label="Источники">
          <h3>Источники</h3>
          <div>{turn.cites.map((cite, index) => <Citation key={`${cite.kind}-${index}`} cite={cite} workspace={workspace} />)}</div>
        </section>}
        {turn.changed.length > 0 && <ChangedFiles paths={turn.changed} />}
      </>}
      {(turn.status === 'failed' || turn.status === 'interrupted') && <Alert status="danger" role="alert">
        <Alert.Content><Alert.Title>{turn.status === 'failed' ? 'Запрос не выполнен' : 'Запрос прерван'}</Alert.Title>
          <Alert.Description>{faultText(turn.error)}</Alert.Description></Alert.Content>
      </Alert>}
    </section>
  </article>;
}

export { faultText as agentFaultText };
