import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { LivePreviewEditor } from './LivePreviewEditor';
import '../vaultTheme.css';

const body = '# POST /srv/spro/history/query\n\nВозвращает историю изменений по заданным параметрам. #api\n';
const yaml = 'title: POST /srv/spro/history/query\nconfluence_page_id: 172069639\nconfluence_url: https://wiki.example.com/pages/viewpage.action?pageId=172069639\nconfluence_space: INV\nconfluence_version: 1\nreviewed: true\ntags: [api, confluence]\n';
const sample = (header: string) => `---\n${header}---\n\n${body}`;

function EditorStory({ initialSource, narrow, theme = 'light', readOnly }: {
  readonly initialSource: string;
  readonly narrow?: boolean;
  readonly theme?: 'light' | 'dark';
  readonly readOnly?: boolean;
}) {
  const [source, setSource] = useState(initialSource);
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-theme');
    root.setAttribute('data-theme', theme);
    return () => {
      if (previous === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', previous);
    };
  }, [theme]);
  return <main lang="ru" className={`mx-auto flex h-screen flex-col bg-background text-foreground ${narrow ? 'max-w-[390px]' : ''}`}>
    <header className="border-b border-separator bg-surface px-4 py-3 text-sm font-medium">history-query</header>
    <div className="vault-document min-h-0 flex-1" data-format="markdown">
      <LivePreviewEditor source={source} onChange={setSource} documentProperties theme={theme} readOnly={readOnly}
        ariaLabel="Текст заметки" renderDiagram={() => null} />
    </div>
    <output aria-label="Исходник Markdown" hidden>{source}</output>
  </main>;
}

const meta = {
  id: 'vault-document-properties',
  title: 'Live Preview/Свойства документа',
  component: EditorStory,
  args: { initialSource: sample(yaml) },
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
} satisfies Meta<typeof EditorStory>;

export default meta;
type Story = StoryObj<typeof meta>;

function markdown(canvas: Parameters<NonNullable<Story['play']>>[0]['canvas']) {
  return canvas.getByLabelText('Исходник Markdown').textContent;
}

const undoKey = () => /Mac|iPhone|iPad/.test(navigator.platform) ? '{Meta>}z{/Meta}' : '{Control>}z{/Control}';

export const Properties: Story = {
  name: 'Свойства в заметке',
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Удалить тег api' }));
    await expect(canvas.queryByRole('button', { name: 'Удалить тег api' })).not.toBeInTheDocument();
    await expect(markdown(canvas)).toBe(sample(yaml.replace('[api, confluence]', '["confluence"]')));
    canvas.getByRole('textbox', { name: 'Текст заметки' }).focus();
    await userEvent.keyboard(undoKey());
    await expect(await canvas.findByRole('button', { name: 'Удалить тег api' })).toBeVisible();
    await expect(markdown(canvas)).toBe(sample(yaml));
  },
};

export const Empty: Story = {
  name: 'Заметка без свойств',
  args: { initialSource: '# Новая заметка\n' },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Добавить свойство' }));
    await userEvent.type(canvas.getByRole('combobox', { name: 'Имя свойства' }), 'owner');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Значение' }), 'Команда API');
    await userEvent.click(canvas.getByRole('button', { name: /^Добавить$/ }));
    await expect(await canvas.findByRole('textbox', { name: 'Значение owner' })).toHaveValue('Команда API');
    await expect(markdown(canvas)).toBe('---\nowner: "Команда API"\n---\n\n# Новая заметка\n');
  },
};

export const Narrow: Story = {
  name: 'Добавление в узком окне',
  args: { initialSource: '# Новая заметка\n', narrow: true, theme: 'dark' },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Добавить свойство' }));
    const name = await canvas.findByRole('combobox', { name: 'Имя свойства' });
    await userEvent.type(name, 'draft');
    await userEvent.keyboard('{Escape}');
    await expect(await canvas.findByRole('button', { name: 'Добавить свойство' })).toBeVisible();
    await expect(markdown(canvas)).toBe('# Новая заметка\n');
    await userEvent.click(canvas.getByRole('button', { name: 'Добавить свойство' }));
    await expect(canvas.getByRole('combobox', { name: 'Имя свойства' })).toHaveValue('');
    await userEvent.type(canvas.getByRole('combobox', { name: 'Имя свойства' }), 'owner');
  },
};

export const AddFlag: Story = {
  name: 'Флажок в форме добавления свойства',
  args: { theme: 'dark' },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Добавить свойство' }));
    const type = canvas.getByRole('button', { name: /Тип/ });
    await userEvent.click(type);
    await userEvent.click(await screen.findByRole('option', { name: 'Флажок' }));
    const flag = await canvas.findByText('Значение', { exact: true });
    const name = canvas.getByRole('combobox', { name: 'Имя свойства' }).getBoundingClientRect();
    const field = type.getBoundingClientRect();
    const label = flag.getBoundingClientRect();
    if (field.left >= name.right) {
      await expect(label.left).toBeGreaterThanOrEqual(field.right);
      await expect(Math.abs(label.top + label.height / 2 - (field.top + field.height / 2))).toBeLessThanOrEqual(1);
    } else {
      await expect(label.top).toBeGreaterThanOrEqual(field.bottom);
    }
    await userEvent.click(flag);
    await expect(canvas.getByRole('checkbox', { name: /^Значение$/ })).toBeChecked();
  },
};

export const HoverPropertyName: Story = {
  name: 'Подсветка имени свойства при наведении',
  args: { theme: 'dark' },
  play: async ({ canvas, userEvent }) => {
    const name = await canvas.findByRole('button', { name: 'Переименовать confluence_version' });
    await userEvent.hover(name);
    const text = document.createRange();
    text.selectNodeContents(name);
    const label = text.getBoundingClientRect();
    const target = name.getBoundingClientRect();
    await expect(Math.min(label.left - target.left, target.right - label.right)).toBeGreaterThanOrEqual(4);
    await expect(Math.min(label.top - target.top, target.bottom - label.bottom)).toBeGreaterThanOrEqual(4);

    const add = canvas.getByRole('button', { name: 'Добавить свойство' });
    const theme = name.closest('[data-theme]');
    if (!(theme instanceof HTMLElement)) throw new Error('Нет контейнера темы HeroUI');
    const radius = getComputedStyle(add).borderRadius;
    await expect(getComputedStyle(name).borderRadius).toBe(radius);

    const previous = theme.style.getPropertyValue('--radius');
    const priority = theme.style.getPropertyPriority('--radius');
    theme.style.setProperty('--radius', '0.25rem');
    try {
      const themedRadius = getComputedStyle(add).borderRadius;
      await expect(themedRadius).not.toBe(radius);
      await expect(getComputedStyle(name).borderRadius).toBe(themedRadius);
    } finally {
      theme.style.setProperty('--radius', previous, priority);
    }
  },
};

export const RowActions: Story = {
  name: 'Меню строки',
  args: { theme: 'dark' },
  play: async ({ canvas, userEvent }) => {
    const actions = (key: string) => canvas.getByRole('button', { name: `Действия: ${key}` });
    const choose = async (key: string, item: string) => {
      await userEvent.click(actions(key));
      await userEvent.click(await screen.findByRole('menuitem', { name: item }));
    };
    await choose('confluence_space', 'Переименовать');
    const name = canvas.getByRole('textbox', { name: 'Новое имя свойства' });
    await userEvent.clear(name);
    await userEvent.type(name, 'space{Enter}');
    await expect(await canvas.findByRole('textbox', { name: 'Значение space' })).toHaveValue('INV');
    await choose('space', 'Удалить свойство');
    await expect(canvas.queryByRole('textbox', { name: 'Значение space' })).not.toBeInTheDocument();
    await expect(markdown(canvas)).toBe(sample(yaml.replace('confluence_space: INV\n', '')));
    canvas.getByRole('textbox', { name: 'Текст заметки' }).focus();
    await userEvent.keyboard(undoKey());
    await expect(await canvas.findByRole('textbox', { name: 'Значение space' })).toHaveValue('INV');
    await userEvent.keyboard(undoKey());
    await expect(await canvas.findByRole('textbox', { name: 'Значение confluence_space' })).toHaveValue('INV');
    await userEvent.click(actions('tags'));
    const tagsMenu = await screen.findByRole('menu');
    await expect(within(tagsMenu).queryByRole('menuitem', { name: 'Переименовать' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(actions('confluence_space'));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Переименовать' })).toBeVisible());
  },
};

export const UnsupportedYaml: Story = {
  name: 'Неподдерживаемое поле',
  args: { initialSource: sample(yaml + 'original_confluence_page_id: null\naliases: [История изменений]\n') },
  play: async ({ canvas, userEvent }) => {
    await expect(await canvas.findByText('null', { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Действия: original_confluence_page_id' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Удалить свойство' }));
    await expect(markdown(canvas)).toBe(sample(yaml + 'aliases: [История изменений]\n'));
    await expect(await canvas.findByText('Только чтение')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Значение title' })).toBeEnabled();
  },
};

export const RenameOnBlur: Story = {
  name: 'Переименование по нажатию на имя',
  args: { theme: 'dark' },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Переименовать confluence_url' }));
    const name = canvas.getByRole('textbox', { name: 'Новое имя свойства' });
    await expect(name).toHaveFocus();
    const value = canvas.getByRole('textbox', { name: 'Значение confluence_url' });
    const a = name.getBoundingClientRect();
    const b = value.getBoundingClientRect();
    await expect(a.right < b.left || a.bottom < b.top).toBe(true);
    await userEvent.clear(name);
    await userEvent.type(name, 'wiki_url');
    await userEvent.click(canvas.getByRole('textbox', { name: 'Текст заметки' }));
    await expect(await canvas.findByRole('button', { name: 'Переименовать wiki_url' })).toBeVisible();
    await expect(markdown(canvas)).toBe(sample(yaml.replace('confluence_url:', 'wiki_url:')));
    await userEvent.click(canvas.getByRole('button', { name: 'Переименовать wiki_url' }));
    const duplicate = canvas.getByRole('textbox', { name: 'Новое имя свойства' });
    await userEvent.clear(duplicate);
    await userEvent.type(duplicate, 'title');
    await userEvent.click(canvas.getByRole('textbox', { name: 'Текст заметки' }));
    await expect(canvas.queryByRole('textbox', { name: 'Новое имя свойства' })).not.toBeInTheDocument();
    await expect(markdown(canvas)).toBe(sample(yaml.replace('confluence_url:', 'wiki_url:')));
  },
};

export const BodyEditing: Story = {
  name: 'Редактирование текста после свойств',
  play: async ({ canvas, userEvent }) => {
    await canvas.findByRole('button', { name: 'Свойства' });
    const editor = canvas.getByRole('textbox', { name: 'Текст заметки' });
    editor.focus();
    await userEvent.keyboard(/Mac|iPhone|iPad/.test(navigator.platform) ? '{Meta>}{ArrowUp}{/Meta}' : '{Control>}{Home}{/Control}');
    await userEvent.keyboard('Body');
    await expect(markdown(canvas)).toBe(`---\n${yaml}---\nBody\n${body}`);
  },
};

export const PropertiesOnly: Story = {
  name: 'Первый текст после свойств',
  args: { initialSource: '---\ntitle: Note\n---' },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await canvas.findByRole('textbox', { name: 'Значение title' });
    const line = canvasElement.querySelector('.cm-line');
    if (!(line instanceof HTMLElement)) throw new Error('Нет строки для первого абзаца');
    await userEvent.click(line);
    await userEvent.keyboard('Body');
    await waitFor(() => expect(markdown(canvas)).toBe('---\ntitle: Note\n---\nBody'));
  },
};

export const InvalidYaml: Story = {
  name: 'Ошибка YAML',
  args: { initialSource: sample('tags: [api,\n') },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Не удалось разобрать YAML');
    await expect(canvas.getByRole('textbox', { name: 'Текст заметки' })).toHaveTextContent(/tags: \[api,/);
    await expect(canvas.queryByRole('button', { name: 'Добавить свойство' })).not.toBeInTheDocument();
  },
};

export const Locked: Story = {
  name: 'Документ заблокирован',
  args: { readOnly: true },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('textbox', { name: 'Значение title' })).toHaveAttribute('readonly');
    await expect(canvas.queryByRole('button', { name: 'Удалить тег api' })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Добавить свойство' })).not.toBeInTheDocument();
  },
};
