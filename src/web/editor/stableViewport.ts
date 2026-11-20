import { ViewPlugin } from '@codemirror/view';

export const stableViewport = ViewPlugin.define(() => ({
  update({ view, viewportMoved, docChanged }) {
    if (!viewportMoved || docChanged) return;
    const { contentDOM, contentHeight, scaleY } = view;
    // При замене виртуального промежутка на блок DOM может временно стать ниже.
    // Сохраняем расчётную высоту до конца обновления, чтобы браузер не ограничил scrollTop.
    contentDOM.style.minHeight = `max(100%, ${contentHeight / scaleY}px)`;
    queueMicrotask(() => contentDOM.style.removeProperty('min-height'));
  }
}));
