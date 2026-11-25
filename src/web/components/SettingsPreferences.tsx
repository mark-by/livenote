import { useState } from 'react';
import { Check, ChevronDown } from '@gravity-ui/icons';
import { Description, Label, ListBox, Select, Separator, Surface, Switch } from '@heroui/react';
import { MERMAID_THEMES } from '../../shared/types';
import { getThemeOverride, setThemeOverride } from '../mermaidInit';

export type PageWidth = 'standard' | 'wide' | 'full';

export const PAGE_WIDTHS: ReadonlyArray<{ readonly value: PageWidth; readonly label: string }> = [
  { value: 'standard', label: 'Обычная' },
  { value: 'wide', label: 'Широкая' },
  { value: 'full', label: 'На всю' }
];

const themeOptions = [
  { value: 'server', label: 'Как на сервере' },
  ...MERMAID_THEMES.map(theme => ({ value: theme, label: theme }))
];
const selectRow = 'grid min-w-0 gap-x-4 gap-y-1 px-5 py-4 min-[50rem]:min-h-21 min-[50rem]:grid-cols-[minmax(0,1fr)_10.5rem] min-[50rem]:content-center';

function PreferenceSelect({ field, label, description, value, onChange, options }: {
  readonly field: string;
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}): React.JSX.Element {
  return <div data-settings-field={field}>
    <Select variant="secondary" className={selectRow} value={value} onChange={key => {
      if (typeof key === 'string') onChange(key);
    }}>
      <Label className="text-base font-semibold text-foreground">{label}</Label>
      <Description className="min-[50rem]:col-start-1">{description}</Description>
      <Select.Trigger className="mt-3 h-11 w-full min-w-0 border border-separator-tertiary min-[50rem]:col-start-2 min-[50rem]:row-start-1 min-[50rem]:row-span-2 min-[50rem]:mt-0 min-[50rem]:h-9 min-[50rem]:self-center">
        <Select.Value />
        <Select.Indicator><ChevronDown className="size-4 shrink-0" aria-hidden="true" /></Select.Indicator>
      </Select.Trigger>
      <Select.Popover><ListBox>
        {options.map(option => <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
          {option.label}
          <ListBox.ItemIndicator>
            {({ isSelected }) => isSelected && <Check className="size-4" aria-hidden="true" />}
          </ListBox.ItemIndicator>
        </ListBox.Item>)}
      </ListBox></Select.Popover>
    </Select>
  </div>;
}

export function AppearanceSettings({ pageWidth, onPageWidthChange }: {
  readonly pageWidth: PageWidth;
  readonly onPageWidthChange: (width: PageWidth) => void;
}): React.JSX.Element {
  const [theme, setTheme] = useState(() => getThemeOverride() ?? 'server');
  return <Surface variant="secondary" className="rounded-2xl">
    <PreferenceSelect field="width" label="Ширина страницы" description="Ограничивает ширину текста в заметках."
      value={pageWidth} options={PAGE_WIDTHS} onChange={value => {
        const match = PAGE_WIDTHS.find(option => option.value === value);
        if (match) onPageWidthChange(match.value);
      }} />
    <Separator className="mx-5 h-px w-auto! bg-separator-secondary" />
    <PreferenceSelect field="mermaid" label="Тема Mermaid" description="Меняет оформление диаграмм Mermaid."
      value={theme} options={themeOptions} onChange={value => {
        const match = MERMAID_THEMES.find(candidate => candidate === value);
        if (match || value === 'server') {
          setTheme(match ?? 'server');
          setThemeOverride(match ?? null);
        }
      }} />
  </Surface>;
}

function PreferenceSwitch({ field, label, description, selected, onChange }: {
  readonly field: string;
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
  readonly onChange: (selected: boolean) => void;
}): React.JSX.Element {
  return <div data-settings-field={field}>
    <Switch className="w-full" isSelected={selected} onChange={onChange}>
      <Switch.Content className="relative flex min-h-20 w-full justify-between gap-4 px-5 py-4">
        <span className="grid min-w-0 gap-1">
          <Label className="text-base font-semibold text-foreground">{label}</Label>
          <Description className="text-sm font-normal text-muted">{description}</Description>
        </span>
        <Switch.Control className="inset-ring inset-ring-border-secondary"><Switch.Thumb /></Switch.Control>
      </Switch.Content>
    </Switch>
  </div>;
}

export function EditorSettings({ vimEnabled, onVimEnabledChange, followEvents, onFollowChange }: {
  readonly vimEnabled?: boolean | undefined;
  readonly onVimEnabledChange?: ((enabled: boolean) => void) | undefined;
  readonly followEvents: boolean;
  readonly onFollowChange: (follow: boolean) => void;
}): React.JSX.Element {
  return <Surface variant="secondary" className="rounded-2xl">
    {onVimEnabledChange && <>
      <PreferenceSwitch field="vim" label="Режим Vim" description="Включает команды и режимы Vim в редакторе заметок."
        selected={vimEnabled ?? false} onChange={onVimEnabledChange} />
      <Separator className="mx-5 h-px w-auto! bg-separator-secondary" />
    </>}
    <PreferenceSwitch field="follow" label="Следовать за изменениями" description="Переходит к заметке, которую изменили извне."
      selected={followEvents} onChange={onFollowChange} />
  </Surface>;
}
