/**
 * Точка входа веб-интерфейса LiveNote.
 */
import { createRoot } from 'react-dom/client';
import { Toast } from '@heroui/react';
import { App } from './App';
import './heroui.css';
import './styles.css';
import './vault.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Не найден корневой элемент #root');
}

createRoot(container).render(<><App /><Toast.Provider /></>);
