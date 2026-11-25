import { Minus, Plus } from '@gravity-ui/icons';
import { Description, Label, NumberField, Radio, RadioGroup, Separator, Surface } from '@heroui/react';
import type { AgentSearchMode } from '../../shared/types';
import {
  AGENT_MAX_CONTEXT_LIMIT_TOKENS,
  AGENT_MIN_CONTEXT_LIMIT_TOKENS,
  isAgentContextLimitTokens
} from './agentStorage';

export interface AgentContextSettingsProps {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly search: AgentSearchMode;
  readonly onSearchChange: (value: AgentSearchMode) => void;
}

export function AgentContextSettings({ value, onChange, search, onSearchChange }: AgentContextSettingsProps): React.JSX.Element {
  const row = 'grid min-w-0 gap-x-4 gap-y-1 px-5 py-4 min-[50rem]:grid-cols-[minmax(0,1fr)_14rem]';
  return <Surface variant="secondary" className="rounded-2xl">
    <div data-settings-field="search">
      <RadioGroup className={row} value={search} onChange={next => {
        if (next === 'docsFirst' || next === 'codeFirst') onSearchChange(next);
      }}>
        <Label className="text-base font-semibold text-foreground">Порядок поиска</Label>
        <Description className="min-[50rem]:col-start-1 min-[50rem]:self-start">Что агент проверяет первым при поиске.</Description>
        <div className="mt-2 grid min-w-0 gap-1 min-[50rem]:col-start-2 min-[50rem]:row-start-1 min-[50rem]:row-span-2 min-[50rem]:mt-0">
          <Radio value="docsFirst"><Radio.Content className="min-h-10 min-[50rem]:min-h-8"><Radio.Control><Radio.Indicator /></Radio.Control>Сначала документы</Radio.Content></Radio>
          <Radio value="codeFirst"><Radio.Content className="min-h-10 min-[50rem]:min-h-8"><Radio.Control><Radio.Indicator /></Radio.Control>Сначала код</Radio.Content></Radio>
        </div>
      </RadioGroup>
    </div>
    <Separator className="mx-5 h-px w-auto! bg-separator-secondary" />
    <div data-settings-field="context">
      <NumberField className={row} variant="secondary" isRequired
        minValue={AGENT_MIN_CONTEXT_LIMIT_TOKENS} maxValue={AGENT_MAX_CONTEXT_LIMIT_TOKENS} step={1}
        value={value} onChange={next => { if (isAgentContextLimitTokens(next)) onChange(next); }}
        formatOptions={{ useGrouping: false, maximumFractionDigits: 0 }}
      >
        <Label className="text-base font-semibold text-foreground">Лимит контекста агента</Label>
        <Description className="min-[50rem]:col-start-1">От 8 192 до 1 048 576 токенов. Оставьте в окне модели место для ответа.</Description>
        <div className="mt-2 w-full min-[50rem]:col-start-2 min-[50rem]:row-start-1 min-[50rem]:row-span-2 min-[50rem]:mt-0 min-[50rem]:w-42 min-[50rem]:justify-self-end">
          <NumberField.Group className="h-11 border border-separator-tertiary min-[50rem]:h-9">
            <NumberField.DecrementButton aria-label="Уменьшить лимит"><Minus className="size-4" aria-hidden="true" /></NumberField.DecrementButton>
            <NumberField.Input className="text-center" />
            <NumberField.IncrementButton aria-label="Увеличить лимит"><Plus className="size-4" aria-hidden="true" /></NumberField.IncrementButton>
          </NumberField.Group>
          <p className="mt-2 text-xs text-muted" aria-hidden="true">токенов</p>
        </div>
      </NumberField>
    </div>
  </Surface>;
}
