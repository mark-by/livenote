import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import './agent.css';
import { fixtureVaultId } from '../../../.storybook/msw-handlers';
import { AgentBindingDialog } from './AgentBindingDialog';

const meta = {
  component: AgentBindingDialog,
  tags: ['ai-generated'],
  args: { vaultId: fixtureVaultId, onClose: fn() },
} satisfies Meta<typeof AgentBindingDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UnboundFolder: Story = { args: { folder: '' } };

export const ExistingBinding: Story = {
  args: { folder: 'Проект' },
  play: async ({ canvasElement }) => {
    const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog');
    const revision = await within(dialog).findByRole('textbox', { name: 'Ветка или ревизия' });
    await expect(revision).toHaveValue('release');
  },
};
