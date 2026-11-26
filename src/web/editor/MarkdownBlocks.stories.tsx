import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { useState } from 'react';
import { LivePreviewEditor } from './LivePreviewEditor';
import '../vaultTheme.css';

function Note({ initialSource }: { readonly initialSource: string }) {
  const [source, setSource] = useState(initialSource);
  return <main lang="ru" className="vault-document h-screen bg-background text-foreground" data-format="markdown">
    <LivePreviewEditor ariaLabel="Текст заметки" source={source} onChange={setSource}
      documentProperties renderDiagram={() => null} />
  </main>;
}

const meta = {
  id: 'live-preview-markdown-blocks',
  title: 'Live Preview/Блоки Markdown',
  component: Note,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
} satisfies Meta<typeof Note>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ThematicBreak: Story = {
  name: 'Линии между разделами',
  args: { initialSource: '---\ntitle: Заметка\n---\n\n# Начало\n\n---\n\n***\n\n___\n\n```md\n---\n```\n\nЗаголовок\n---\n' },
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getAllByRole('separator')).toHaveLength(3));
    await expect(canvas.getByRole('heading', { name: 'Заголовок' })).toBeVisible();
  },
};

const mapping = 'Маппинг → interest_history_grants (UPSERT)';

export const DetailsWithTable: Story = {
  name: 'Раскрываемый блок с таблицей',
  args: { initialSource: `# История изменений

<details><summary>${mapping}</summary>

| Колонка | Обяз. | Источник |
| --- | --- | --- |
| \`interest_id\` | да | тело запроса |

</details>

После таблицы.
` },
  play: async ({ canvas, userEvent }) => {
    const trigger = await canvas.findByRole('button', { name: mapping });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.queryByRole('grid')).not.toBeInTheDocument();
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const cell = await canvas.findByRole('rowheader', { name: 'interest_id' });
    await waitFor(() => expect(cell).toBeVisible());
    await expect(getComputedStyle(cell).borderLeftWidth).toBe('0px');
    await userEvent.keyboard(' ');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.getByText('После таблицы.')).toBeVisible();
  },
};

export const DetailsInList: Story = {
  name: 'Раскрываемая таблица внутри списка',
  args: { initialSource: `## Создание/обновление БД

10. Upsert \`interest_history_grants\` по \`interest_id\`.

    <details><summary>${mapping}</summary>

    | Колонка | Обяз. | Источник |
    | --- | --- | --- |
    | \`interest_id\` | да | тело запроса |

    </details>

После списка.
` },
  play: async ({ canvas, userEvent }) => {
    const trigger = await canvas.findByRole('button', { name: mapping });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.queryByRole('grid')).not.toBeInTheDocument();
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(canvas.getByRole('rowheader', { name: 'interest_id' })).toBeVisible());
    await userEvent.keyboard(' ');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.queryByRole('grid')).not.toBeInTheDocument();
    await expect(canvas.getByText('После списка.')).toBeVisible();
  },
};

export const MultilineSummary: Story = {
  name: 'Многострочный заголовок раскрываемого блока',
  args: { initialSource: '# Заметка\n\n<details>\n  <summary>\n    Some\n  </summary>\n  content\n</details>\n' },
  play: async ({ canvas, userEvent }) => {
    const trigger = await canvas.findByRole('button', { name: /^Some$/ });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(canvas.getByText('content', { exact: true })).toBeVisible());
  },
};

export const InlineSpoilers: Story = {
  name: 'Однострочные и вложенные спойлеры',
  args: {
    initialSource: 'Before <details><summary>Some</summary>content</details> After\n\n' +
      '<details open><summary>Outer</summary><details><summary>Inner</summary>nested text</details></details>',
  },
  play: async ({ canvas, userEvent }) => {
    const trigger = await canvas.findByRole('button', { name: 'Some' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    await waitFor(() => expect(canvas.getByText('content', { exact: true })).toBeVisible());
    await expect(canvas.getByText('Before', { exact: true })).toBeVisible();
    await expect(canvas.getByText('After', { exact: true })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Outer' })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(canvas.getByRole('button', { name: 'Inner' }));
    await waitFor(() => expect(canvas.getByText('nested text')).toBeVisible());
  },
};

export const SeparateSpoilers: Story = {
  name: 'Отдельные карточки спойлеров',
  args: { initialSource: '# Заметка\n\n<details open>\n<summary>Параметры</summary>\n\nОписание\n</details>\n\n<details>\n<summary>Пример</summary>\n\nРезультат\n</details>\n' },
  play: async ({ canvas, userEvent }) => {
    const trigger = await canvas.findByRole('button', { name: 'Параметры' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.queryByRole('button', { name: /Исходник/ })).not.toBeInTheDocument();
    const example = await canvas.findByRole('button', { name: 'Пример' });
    await userEvent.click(example);
    await expect(example).toHaveAttribute('aria-expanded', 'true');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.tab({ shift: true });
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  },
};

export const SpoilersWithBlankLines: Story = {
  name: 'Спойлеры с пустыми строками между ними',
  args: { initialSource: '# Заметка\n\n<details open>\n<summary>Параметры</summary>\n\nОписание\n</details>\n\n\n\n<details>\n<summary>Пример</summary>\n\nРезультат\n</details>\n' },
};

export const CodeHighlighting: Story = {
  name: 'Подсветка синтаксиса в блоках кода',
  args: { initialSource: [
    '# Конфигурация',
    '',
    '```json',
    '{',
    '  "retries": 3,',
    '  "region": "eu-west",',
    '  "enabled": true',
    '}',
    '```',
    '',
    '```ts',
    '// Выбираем адрес для запроса.',
    'const endpoint: string = "api.example.com";',
    '```',
  ].join('\n') },
  play: async ({ canvas }) => {
    const colors = () => ['"retries"', '"eu-west"', '3', 'true', '{'].map(text =>
      getComputedStyle(canvas.getByText(text, { exact: true })).color);
    await waitFor(() => expect(new Set(colors()).size).toBe(5));
  },
};

export const CodeHighlightingDark: Story = {
  ...CodeHighlighting,
  name: 'Подсветка синтаксиса в тёмной теме',
  decorators: [(Story) => <div data-theme="dark"><Story /></div>],
};
