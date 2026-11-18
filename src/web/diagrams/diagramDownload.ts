import { toast } from '@heroui/react';

async function clipboardPng(blob: Blob | void): Promise<Blob> {
  if (!blob) throw new Error('Экспорт не вернул изображение');
  if (blob.type === 'image/png') return blob;

  const image = new Image();
  const svg = await blob.text();
  // Chrome разрешает отрисовать SVG с HTML-подписями через data URL.
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const scale = Math.min(2, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Не удалось создать изображение');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((png) => {
      if (png) resolve(png);
      else reject(new Error('Не удалось преобразовать схему в PNG'));
    }, 'image/png');
  });
}

async function copyImage(downloaded: Promise<Blob | void>): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
  // Запись начинается при нажатии кнопки, пока браузер ещё разрешает доступ к буферу.
  const png = downloaded.then(clipboardPng);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  } catch {
    void png.catch(() => undefined);
    return false;
  }
}

export async function notifyDiagramDownload(
  filename: string, download: () => Blob | void | Promise<Blob | void>
): Promise<void> {
  const downloaded = Promise.resolve().then(download);
  const copied = /\.(svg|png)$/i.test(filename) ? copyImage(downloaded) : null;
  try {
    await downloaded;
  } catch (error) {
    toast.danger('Не удалось скачать схему', {
      description: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  const copiedImage = copied === null ? null : await copied;
  const description = copiedImage === null ? filename : `${filename} · ${
    copiedImage ? 'Изображение в буфере обмена' : 'Не удалось скопировать изображение'
  }`;
  toast.success('Скачивание началось', { description });
}
