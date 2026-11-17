import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

// Конфигурация сборки веб-интерфейса LiveNote.
// Прод-сборка складывается в dist/web и раздаётся сервером как статика.
export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true
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
});
