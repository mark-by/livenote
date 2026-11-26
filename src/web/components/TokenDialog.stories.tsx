import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { TokenDialog } from './TokenDialog';

const meta = {
  component: TokenDialog,
  tags: ['ai-generated'],
  args: { onConfirm: fn() },
} satisfies Meta<typeof TokenDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const SubmitWithKeyboard: Story = {
  play: async ({ args, canvasElement, userEvent }) => {
    const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bearer-токен'), '  demo-token  {Enter}');
    await expect(args.onConfirm).toHaveBeenCalledWith('demo-token');
  },
};
