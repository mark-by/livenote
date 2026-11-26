import { Toast } from '@heroui/react';
import { mswLoader } from 'msw-storybook-addon/csf3';
import type { Preview } from '@storybook/react-vite';
import '../src/web/heroui.css';
import '../src/web/styles.css';
import '../src/web/vault.css';
import { mswHandlers } from './msw-handlers';

const preview: Preview = {
  decorators: [
    (Story) => <><Story /><Toast.Provider /></>,
  ],
  loaders: [mswLoader()],
  beforeEach({ msw }) {
    msw.use(...mswHandlers);
  },
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },

    a11y: {
      test: 'todo',
    },
  },
};

export default preview;
