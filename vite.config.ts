import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

// Конфигурация сборки веб-интерфейса LiveNote.
// Прод-сборка складывается в dist/web и раздаётся сервером как статика.
export default defineConfig(({ mode }) => ({
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
  }
}));
