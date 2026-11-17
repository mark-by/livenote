/**
 * Кнопка «Копировать»: пишет текст в буфер обмена и показывает галочку-подтверждение.
 * Используется на всех типах блоков (markdown / mermaid / bpmn) — копируется исходник.
 * Внешний вид задаётся полностью через className (у каждого контейнера свои кнопки).
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Tooltip } from '@heroui/react';
import { Copy, Check } from '@gravity-ui/icons';

interface CopyButtonProps {
  /** Что скопировать: исходник блока (markdown-текст, mermaid, BPMN XML). */
  text: string;
  /** Подсказка/aria: например «Копировать исходник». */
  title: string;
  /** Стиль кнопки контейнера (block-action / mermaid-expand-стиль / bpmn-controls__btn). */
  className: string;
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

  const copy = (): void => {
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
    <Tooltip delay={300}><Button
      variant="ghost"
      size="sm"
      className={className}
      onPress={copy}
      aria-label={copied ? 'Скопировано' : title}
      isIconOnly
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button><Tooltip.Content>{copied ? 'Скопировано' : title}</Tooltip.Content></Tooltip>
  );
}
