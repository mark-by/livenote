/**
 * Кнопка «Копировать»: пишет текст в буфер обмена и показывает галочку-подтверждение.
 * Используется на всех типах блоков (markdown / mermaid / bpmn) — копируется исходник.
 * Внешний вид задаётся полностью через className (у каждого контейнера свои кнопки).
 */
import { useEffect, useRef, useState } from 'react';

interface CopyButtonProps {
  /** Что скопировать: исходник блока (markdown-текст, mermaid, BPMN XML). */
  text: string;
  /** Подсказка/aria: например «Копировать исходник». */
  title: string;
  /** Стиль кнопки контейнера (block-action / mermaid-expand-стиль / bpmn-controls__btn). */
  className: string;
}

/** Иконка «копировать» (lucide copy, stroke-стиль). */
function CopyIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

/** Иконка-галочка: показывается 1.5 секунды после успешного копирования. */
function CheckIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function CopyButton({ text, title, className }: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  // Таймер сброса галочки снимается при размонтировании.
  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    };
  }, []);

  const copy = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (resetTimer.current !== null) {
          window.clearTimeout(resetTimer.current);
        }
        resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch((error: unknown) => {
        console.error('Не удалось скопировать в буфер обмена:', error);
      });
  };

  return (
    <button
      type="button"
      className={className}
      onClick={copy}
      title={copied ? 'Скопировано' : title}
      aria-label={copied ? 'Скопировано' : title}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
