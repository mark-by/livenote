import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, ChevronLeft, ChevronRight, Display, FaceRobotSmile, Keyboard, Layers, Magnifier, Pencil, PlugConnection, Xmark } from '@gravity-ui/icons';
import { Button, Header, Label, ListBox, Modal, SearchField, Surface, Tooltip } from '@heroui/react';
import type { AgentSlot } from '../../shared/types';
import { AgentConnectionsSettings, useAgentConnectionsSettings } from '../agent/AgentConnectionsSettings';
import { AgentContextSettings } from '../agent/AgentContextSettings';
import type { AgentContextSettingsProps } from '../agent/AgentContextSettings';
import { shortcutIds, shortcutKey, shortcuts } from '../shortcuts';
import { useShortcutBindings } from '../shortcutPreferences';
import { HotkeySettings } from './HotkeySettings';
import { AppearanceSettings, EditorSettings } from './SettingsPreferences';
import type { PageWidth } from './SettingsPreferences';

export { PAGE_WIDTHS } from './SettingsPreferences';
export type { PageWidth } from './SettingsPreferences';

const appSections = [
  { id: 'appearance', label: 'Внешний вид', icon: Display },
  { id: 'editor', label: 'Редактор', icon: Pencil },
  { id: 'hotkeys', label: 'Горячие клавиши', icon: Keyboard }
] as const;
const agentSections = [
  { id: 'context', label: 'Контекст', icon: Layers },
  { id: 'model', label: 'Модель', icon: FaceRobotSmile },
  { id: 'integrations', label: 'Интеграции', icon: PlugConnection }
] as const;

type SectionId = (typeof appSections | typeof agentSections)[number]['id'];
interface SearchEntry {
  readonly section: SectionId;
  readonly label: string;
  readonly terms: string;
  readonly field?: string;
  readonly integration?: Exclude<AgentSlot, 'model'>;
}

const searchEntries: readonly SearchEntry[] = [
  { section: 'appearance', label: 'Ширина страницы', terms: 'ограничивает ширину текста в заметках обычная широкая на всю', field: 'width' },
  { section: 'appearance', label: 'Тема Mermaid', terms: 'меняет оформление диаграмм как на сервере', field: 'mermaid' },
  { section: 'editor', label: 'Режим Vim', terms: 'включает команды и режимы vim в редакторе заметок', field: 'vim' },
  { section: 'editor', label: 'Следовать за изменениями', terms: 'переходит к заметке которую изменили извне', field: 'follow' },
  { section: 'context', label: 'Порядок поиска', terms: 'что агент проверяет первым при поиске сначала документы код', field: 'search' },
  { section: 'context', label: 'Лимит контекста агента', terms: 'окно модели токенов входной контекст место для ответа', field: 'context' },
  { section: 'model', label: 'Подключение модели', terms: 'base url ключ api токен openai tool_calls модель' },
  ...(['Confluence', 'GitLab', 'GitHub'] as const).map((label): SearchEntry => ({
    section: 'integrations', label, terms: 'mcp endpoint resource host oauth client id токен',
    integration: label === 'Confluence' ? 'confluence' : label === 'GitLab' ? 'gitlab' : 'github'
  }))
];

interface SettingsDialogProps {
  readonly agent?: (AgentContextSettingsProps & { readonly vaultId: string }) | undefined;
  readonly vaultShortcuts?: boolean;
  readonly pageWidth: PageWidth;
  readonly onPageWidthChange: (width: PageWidth) => void;
  readonly followEvents: boolean;
  readonly onFollowChange: (follow: boolean) => void;
  readonly vimEnabled?: boolean;
  readonly onVimEnabledChange?: (enabled: boolean) => void;
  readonly onClose: () => void;
}

const wideQuery = '(min-width: 50rem)';
const getWide = (): boolean => window.matchMedia(wideQuery).matches;
function subscribeWide(listener: () => void): () => void {
  const query = window.matchMedia(wideQuery);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

const iconClass = 'size-4 shrink-0';
const paneHeadingClass = 'mb-6 text-xl font-semibold leading-tight text-foreground min-[50rem]:text-[1.625rem]';

export function SettingsDialog(props: SettingsDialogProps): React.JSX.Element {
  const wide = useSyncExternalStore(subscribeWide, getWide);
  const [section, setSection] = useState<SectionId>('appearance');
  const [compactDetail, setCompactDetail] = useState(false);
  const [query, setQuery] = useState('');
  const [integration, setIntegration] = useState<Exclude<AgentSlot, 'model'>>('confluence');
  const navRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef<{ readonly target: 'nav' | 'pane'; readonly field?: string | undefined } | null>(null);
  const agent = props.agent;
  const groups = [['Приложение', appSections], ['Агент', agent ? agentSections : []]] as const;
  const available = [...appSections, ...(agent ? agentSections : [])];
  const active = available.find(item => item.id === section) ?? appSections[0];
  const bindings = useShortcutBindings();
  const availableShortcuts = shortcutIds.filter(id => id === 'openSettings' ||
    (props.vaultShortcuts && (id !== 'toggleAgent' || agent)));
  const words = query.toLocaleLowerCase('ru').trim().split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  const entries = [...searchEntries, ...availableShortcuts.map((id): SearchEntry => ({
    section: 'hotkeys', label: shortcuts[id].label,
    terms: `hotkeys shortcuts сочетания клавиш ${shortcutKey(bindings[id].code)} ${shortcuts[id].terms}`
  }))];
  const results = searching ? entries.filter(entry => {
    const group = available.find(item => item.id === entry.section);
    return group && (entry.field !== 'vim' || props.onVimEnabledChange) &&
      words.every(word => `${entry.label} ${entry.terms} ${group.label}`.toLocaleLowerCase('ru').includes(word));
  }) : [];
  const showingSection = !searching && (wide || compactDetail);
  const connectionSection = showingSection && (active.id === 'model' || active.id === 'integrations');
  const connections = useAgentConnectionsSettings(agent?.vaultId, connectionSection);

  const selectSection = (id: SectionId, focus: boolean): void => {
    if (focus) focusNext.current = { target: 'pane' };
    setQuery('');
    setSection(id);
    setCompactDetail(true);
  };
  const openResult = (entry: SearchEntry): void => {
    focusNext.current = { target: 'pane', field: entry.field };
    if (entry.integration) setIntegration(entry.integration);
    selectSection(entry.section, false);
  };
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [active.id, searching, wide, compactDetail]);
  useLayoutEffect(() => {
    const request = focusNext.current;
    if (!request) return;
    focusNext.current = null;
    if (request.target === 'nav') {
      navRef.current?.querySelector<HTMLElement>(`[data-settings-section="${active.id}"]`)?.focus();
      return;
    }
    const field = request.field ? contentRef.current?.querySelector<HTMLElement>(`[data-settings-field="${request.field}"]`) : null;
    (field?.querySelector<HTMLElement>('[data-slot="number-field-input"], input:checked, [role="switch"], [data-slot="select-trigger"], input:not([disabled])') ??
      contentRef.current?.querySelector<HTMLElement>('[data-settings-heading]'))?.focus();
  });

  const navigation = <div ref={navRef} className={wide
    ? 'scrollbar min-h-0 min-w-0 overflow-y-auto overscroll-contain border-e border-separator-secondary bg-background-tertiary px-4 py-5'
    : 'scrollbar min-h-0 min-w-0 overflow-y-auto overscroll-contain px-5 py-4'}>
    <SearchField variant="secondary" fullWidth value={query} onChange={setQuery} className="min-w-0"
      onSubmit={() => { const first = results[0]; if (first) openResult(first); }}>
      <Label className="sr-only">Поиск настроек</Label>
      <SearchField.Group className="max-[49.999rem]:h-11">
        <SearchField.SearchIcon><Magnifier className={iconClass} aria-hidden="true" /></SearchField.SearchIcon>
        <SearchField.Input placeholder="Поиск настроек" maxLength={160} className="min-w-0" />
        <SearchField.ClearButton aria-label="Очистить поиск"><Xmark className={iconClass} aria-hidden="true" /></SearchField.ClearButton>
      </SearchField.Group>
    </SearchField>
    {(wide || !searching) && (wide ? <ListBox aria-label="Разделы настроек" className="mt-4 gap-3 p-0"
      selectionMode="single" selectionBehavior="replace" disallowEmptySelection={!searching}
      selectedKeys={searching ? [] : [active.id]} onSelectionChange={keys => {
        const item = keys !== 'all' && available.find(item => keys.has(item.id));
        if (item) selectSection(item.id, false);
      }}
      onAction={key => { const item = available.find(item => item.id === key); if (item && searching) selectSection(item.id, false); }}>
      {groups.map(([group, items]) => items.length > 0 &&
        <ListBox.Section key={group} className="flex flex-col gap-1">
          <Header className="px-2 pt-2 pb-1 text-xs font-semibold text-muted">{group}</Header>
          {items.map(({ id, label, icon: Icon }) => <ListBox.Item key={id} id={id} textValue={label}
            className="min-h-10 items-center gap-2 rounded-2xl border border-transparent px-2.5 py-1 text-sm text-foreground data-[selected]:border-border data-[selected]:bg-segment! data-[selected]:font-semibold data-[selected]:text-segment-foreground!">
            <Icon className={iconClass} aria-hidden="true" /><span className="min-w-0 grow">{label}</span>
            <ListBox.ItemIndicator>{({ isSelected }) => isSelected && <Check className={iconClass} aria-hidden="true" />}</ListBox.ItemIndicator>
          </ListBox.Item>)}
        </ListBox.Section>)}
    </ListBox> : <nav aria-label="Разделы настроек" className="mt-5 grid gap-6">
      {groups.map(([group, items]) => items.length > 0 &&
        <div key={group} className="grid gap-2">
          <h2 className="mb-1 text-sm font-semibold text-muted">{group}</h2>
          {items.map(({ id, label, icon: Icon }) => <Button key={id} data-settings-section={id} variant="secondary"
            className="h-11 w-full justify-start px-3.5 text-base" onPress={() => selectSection(id, true)}>
            <Icon className={iconClass} aria-hidden="true" /><span className="grow text-start">{label}</span>
            <ChevronRight className={iconClass} aria-hidden="true" />
          </Button>)}
        </div>)}
    </nav>)}
    {!wide && searching && <div className="mt-5"><SearchResults entries={results} onOpen={openResult} /></div>}
  </div>;

  return <Modal.Backdrop isOpen onOpenChange={open => { if (!open) props.onClose(); }}>
    <Modal.Container placement="center" scroll="inside" className="p-0! min-[50rem]:p-6!">
      <Modal.Dialog aria-label="Настройки" className="h-dvh w-full max-w-[62.5rem] overflow-clip rounded-none p-0 min-[50rem]:h-[39.75rem] min-[50rem]:rounded-3xl min-[50rem]:ring-1 min-[50rem]:ring-border">
        <Modal.Header className="h-[3.75rem] shrink-0 flex-row items-center gap-2 border-b border-separator-secondary px-5 min-[50rem]:px-6">
          {!wide && showingSection && <Tooltip>
            <Button isIconOnly variant="ghost" aria-label="Назад к разделам" className="-ms-3 size-11 min-w-11" onPress={() => {
              focusNext.current = { target: 'nav' };
              setCompactDetail(false);
            }}><ChevronLeft className={iconClass} aria-hidden="true" /></Button>
            <Tooltip.Content>Назад к разделам</Tooltip.Content>
          </Tooltip>}
          <Modal.Heading className="min-w-0 grow text-xl font-semibold">{!wide && showingSection ? active.label : 'Настройки'}</Modal.Heading>
          <Modal.CloseTrigger aria-label="Закрыть настройки" className="static -me-2 size-9 min-w-9 justify-center max-[49.999rem]:size-11">
            <Xmark className={iconClass} aria-hidden="true" />
          </Modal.CloseTrigger>
        </Modal.Header>
        <Modal.Body className="m-0! grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)] overflow-hidden p-0! min-[50rem]:grid-cols-[14.5rem_minmax(0,1fr)]">
          {(wide || !compactDetail) && navigation}
          {(wide || showingSection) && <div ref={contentRef} data-settings-content
            className="scrollbar min-w-0 overflow-y-auto overscroll-contain px-5 py-6 text-foreground min-[50rem]:px-8">
            {searching ? <SearchResults entries={results} onOpen={openResult} /> : <>
              <h2 className={wide ? paneHeadingClass : 'sr-only'} tabIndex={-1} data-settings-heading>{active.label}</h2>
              {active.id === 'appearance' && <AppearanceSettings pageWidth={props.pageWidth} onPageWidthChange={props.onPageWidthChange} />}
              {active.id === 'editor' && <EditorSettings {...props} />}
              {active.id === 'hotkeys' && <HotkeySettings shortcuts={availableShortcuts} />}
              {active.id === 'context' && agent && <AgentContextSettings {...agent} />}
              {agent && (active.id === 'model' || active.id === 'integrations') &&
                <AgentConnectionsSettings section={active.id} controller={connections} integration={integration} onIntegrationChange={setIntegration} />}
            </>}
          </div>}
        </Modal.Body>
        <Modal.Footer className="m-0! min-h-[3.75rem] shrink-0 border-t border-separator-secondary px-5 py-2.5 min-[50rem]:px-6">
          <Button variant={connectionSection ? 'secondary' : 'primary'} onPress={props.onClose} className="h-11 w-full min-[50rem]:h-9 min-[50rem]:w-auto min-[50rem]:min-w-24">Готово</Button>
        </Modal.Footer>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}

function SearchResults({ entries, onOpen }: {
  readonly entries: readonly SearchEntry[];
  readonly onOpen: (entry: SearchEntry) => void;
}): React.JSX.Element {
  return <>
    <h2 className={paneHeadingClass}>Результаты поиска</h2>
    <Surface variant="secondary" className="overflow-hidden rounded-2xl p-1">
      <p role="status" className={entries.length ? 'sr-only' : 'px-4 py-3 text-sm text-muted'}>
        {entries.length ? `Найдено настроек: ${entries.length}` : 'Ничего не найдено. Попробуйте другой запрос.'}
      </p>
      {entries.map(entry => <Button key={entry.label} variant="ghost"
        className="h-auto min-h-16 w-full justify-between gap-3 rounded-xl px-4 py-2 text-start whitespace-normal"
        onPress={() => onOpen(entry)}>
        <span className="grid min-w-0 gap-1">
          <span className="text-base font-semibold">{entry.label}</span>
          <span className="text-sm text-muted">{[...appSections, ...agentSections].find(item => item.id === entry.section)?.label}</span>
        </span>
        <ChevronRight className={`${iconClass} text-muted`} aria-hidden="true" />
      </Button>)}
    </Surface>
  </>;
}
