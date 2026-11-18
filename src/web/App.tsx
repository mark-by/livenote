import { useEffect, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import type { WebApiConfig } from './api';
import { getConfig, readVaultLocation } from './api';
import { LegacyApp } from './LegacyApp';
import { VaultApp } from './vault/VaultApp';

/** Выбирает документный vault или сохранённый SQLite-интерфейс по конфигурации сервера. */
export function App(): React.JSX.Element {
  const [config, setConfig] = useState<WebApiConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const theme = localStorage.getItem('livenote_color_theme') === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    void getConfig().then((loaded) => {
      const scope = readVaultLocation();
      if (loaded.storage === 'vault' && !scope.explicit && loaded.defaultVaultId) {
        const url = new URL(window.location.href);
        url.searchParams.set('vault_id', loaded.defaultVaultId);
        window.history.replaceState(null, '', url);
      }
      setConfig(loaded);
    }).catch((loadError: unknown) => {
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
  const scope = readVaultLocation();
  if (config.storage === 'vault' && scope.explicit && scope.id === null) {
    return <main className="app-startup-error">
      <h1>Хранилище недоступно</h1>
      <p>Параметр vault_id не содержит идентификатор хранилища.</p>
      <Button variant="primary" onPress={() => {
        const url = new URL(window.location.href);
        url.searchParams.delete('vault_id');
        window.location.replace(url);
      }}>Вернуться к хранилищу</Button>
    </main>;
  }
  return config.storage === 'vault'
    ? <VaultApp config={config} vaultId={scope.id} vaultIdExplicit={scope.explicit} />
    : <LegacyApp />;
}
