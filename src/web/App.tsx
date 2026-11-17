import { useEffect, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import type { ApiConfig } from '../shared/types';
import { getConfig } from './api';
import { LegacyApp } from './LegacyApp';
import { VaultApp } from './vault/VaultApp';

/** Выбирает документный vault или сохранённый SQLite-интерфейс по конфигурации сервера. */
export function App(): React.JSX.Element {
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const theme = localStorage.getItem('livenote_color_theme') === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    void getConfig().then(setConfig).catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
  }, []);

  if (error) {
    return (
      <main className="app-startup-error">
        <h1>LiveNote не отвечает</h1>
        <p>{error}</p>
        <Button variant="primary" onPress={() => window.location.reload()}>Повторить</Button>
      </main>
    );
  }
  if (!config) return <main className="app-startup-error"><Spinner aria-label="Загрузка LiveNote" /></main>;
  return config.storage === 'vault' ? <VaultApp config={config} /> : <LegacyApp />;
}
