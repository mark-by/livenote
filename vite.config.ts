/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

// Конфигурация сборки веб-интерфейса LiveNote.
// Прод-сборка складывается в dist/web и раздаётся сервером как статика.
import path from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
const dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig(({
  mode
}) => ({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    ...(mode === 'desktop' ? {
      rollupOptions: {
        input: {
          app: fileURLToPath(new URL('./src/web/index.html', import.meta.url)),
          diagrams: fileURLToPath(new URL('./src/web/diagram-worker.html', import.meta.url))
        }
      }
    } : {})
  },
  server: {
    port: 5173,
    // Прокси на сервер LiveNote при разработке UI отдельно от сервера
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/events': 'http://127.0.0.1:4317',
      '/mcp': 'http://127.0.0.1:4317'
    }
  },
  test: {
    projects: [{
      extends: true,
      plugins: [
      // The plugin will run tests for the stories defined in your Storybook config
      // See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
      storybookTest({
        configDir: path.join(dirname, '.storybook')
      })],
      test: {
        name: 'storybook',
        browser: {
          enabled: true,
          headless: true,
          provider: playwright({}),
          instances: [{
            browser: 'chromium'
          }]
        }
      }
    }]
  }
}));