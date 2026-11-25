import { Description, Label, NumberField, Radio, RadioGroup } from '@heroui/react';
import type { AgentSearchMode } from '../../shared/types';
import {
  AGENT_MAX_CONTEXT_LIMIT_TOKENS,
  AGENT_MIN_CONTEXT_LIMIT_TOKENS,
  isAgentContextLimitTokens
} from './agentStorage';

interface AgentContextSettingsProps {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly search: AgentSearchMode;
  readonly onSearchChange: (value: AgentSearchMode) => void;
}

export function AgentContextSettings({ value, onChange, search, onSearchChange }: AgentContextSettingsProps): React.JSX.Element {
  return <section className="agent-context" aria-label="Контекст агента">
    <h3>Контекст агента</h3>
    <RadioGroup value={search} onChange={next => {
      if (next === 'docsFirst' || next === 'codeFirst') onSearchChange(next);
    }}>
      <Label>Порядок поиска</Label>
      <Radio value="docsFirst"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>Сначала документы</Radio.Content></Radio>
      <Radio value="codeFirst"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>Сначала код</Radio.Content></Radio>
    </RadioGroup>
    <NumberField
      fullWidth
      isRequired
      minValue={AGENT_MIN_CONTEXT_LIMIT_TOKENS}
      maxValue={AGENT_MAX_CONTEXT_LIMIT_TOKENS}
      step={1}
      defaultValue={value}
      onChange={next => { if (isAgentContextLimitTokens(next)) onChange(next); }}
      formatOptions={{ useGrouping: false, maximumFractionDigits: 0 }}
    >
      <Label>Лимит контекста агента</Label>
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input />
        <NumberField.IncrementButton />
      </NumberField.Group>
      <Description>Лимит входного контекста: от 8 192 до 1 048 576 токенов. Оставьте в окне модели место для ответа.</Description>
    </NumberField>
  </section>;
}
