import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { MarkdownBlockView } from './MarkdownBlockView';

const meta = {
  component: MarkdownBlockView,
  tags: ['ai-generated'],
} satisfies Meta<typeof MarkdownBlockView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CssCheck: Story = {
  args: { source: '# План проекта\n\nПервая версия готова к обсуждению.' },
  play: async ({ canvas }) => {
    const heading = canvas.getByRole('heading', { level: 1 });
    await expect(getComputedStyle(heading).fontWeight).toBe('700');
  },
};

export const Checklist: Story = {
  args: { source: '## План работы\n\n- [x] Подготовить заметки\n- [ ] Проверить схему' },
};

export const UnresolvedWikiLink: Story = {
  args: { source: 'См. также [[Архив#Планы|планы из архива]].' },
};
