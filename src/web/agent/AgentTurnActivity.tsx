import { Button, Disclosure, Spinner } from '@heroui/react';
import type { AgentProgressEvent, AgentProgressSource, AgentTurnProgress } from '../../shared/types';

interface AgentTurnActivityProps {
  readonly progress?: AgentTurnProgress;
  readonly running: boolean;
}

type ActionText = (source?: AgentProgressSource) => string;

const sourceNames: Readonly<Record<AgentProgressSource, string>> = {
  vault: 'хранилище', localCode: 'локальный код', remoteCode: 'удалённый код', confluence: 'Confluence'
};
const searchPlaces: Readonly<Record<AgentProgressSource, string>> = {
  vault: 'в хранилище', localCode: 'в локальном коде', remoteCode: 'в удалённом коде', confluence: 'в Confluence'
};
const currentReading: Readonly<Record<AgentProgressSource, string>> = {
  vault: 'документ из хранилища', localCode: 'локальный исходник',
  remoteCode: 'удалённый исходник', confluence: 'страницу Confluence'
};
const logReading: Readonly<Record<AgentProgressSource, string>> = {
  vault: 'документа из хранилища', localCode: 'локального исходника',
  remoteCode: 'удалённого исходника', confluence: 'страницы Confluence'
};

const currentText: Readonly<Record<AgentProgressEvent['kind'], ActionText>> = {
  plan: () => 'Составляет план',
  model: () => 'Ожидает ответ модели',
  verify: () => 'Проверяет результат',
  search: source => source ? `Ищет ${searchPlaces[source]}` : 'Ищет источники',
  next_source: source => source ? `Выбирает источник: ${sourceNames[source]}` : 'Выбирает следующий источник',
  read_vault: source => source ? `Читает ${currentReading[source]}` : 'Читает документ',
  read_source: source => source ? `Читает ${currentReading[source]}` : 'Читает исходник',
  check: () => 'Проверяет схему',
  stage: () => 'Подготавливает изменения',
  commit: () => 'Записывает изменения'
};

const logText: Readonly<Record<AgentProgressEvent['kind'], ActionText>> = {
  plan: () => 'Составление плана',
  model: () => 'Ожидание ответа модели',
  verify: () => 'Проверка результата',
  search: source => source ? `Поиск ${searchPlaces[source]}` : 'Поиск источников',
  next_source: source => source ? `Выбор источника: ${sourceNames[source]}` : 'Выбор следующего источника',
  read_vault: source => source ? `Чтение ${logReading[source]}` : 'Чтение документа',
  read_source: source => source ? `Чтение ${logReading[source]}` : 'Чтение исходника',
  check: () => 'Проверка схемы',
  stage: () => 'Подготовка изменений',
  commit: () => 'Запись изменений'
};

export function AgentTurnActivity({ progress, running }: AgentTurnActivityProps): React.JSX.Element | null {
  if (!running && !progress) return null;
  const current = running ? progress?.events.at(-1) : undefined;
  return <section className="agent-turn__activity" aria-label="Публичные действия агента">
    {running && <div className="agent-turn__status" role="status" aria-live="polite" aria-atomic="true">
      <Spinner size="sm" aria-hidden="true" />
      <div>
        <strong>{current ? currentText[current.kind](current.source) : 'Агент работает'}</strong>
        {!progress && <p>Можно скрыть панель или открыть другой разговор.</p>}
      </div>
    </div>}
    {progress && <>
      <div className="agent-turn__budgets" aria-label="Использованные ресурсы">
        <span>Шаги модели: <strong>{progress.stepsUsed}</strong></span>
      </div>
      {progress.events.length > 0 && <Disclosure className="agent-turn__activity-log">
        <Disclosure.Heading>
          <Button slot="trigger" size="sm" variant="ghost">
            Действия агента <span className="agent-turn__count">{progress.events.length}</span><Disclosure.Indicator />
          </Button>
        </Disclosure.Heading>
        <Disclosure.Content><Disclosure.Body>
          <ol className="agent-turn__activity-items" aria-label="Начатые действия">
            {progress.events.map((event, index) => <li key={`${index}-${event.kind}`}>
              {logText[event.kind](event.source)}
            </li>)}
          </ol>
        </Disclosure.Body></Disclosure.Content>
      </Disclosure>}
    </>}
  </section>;
}
