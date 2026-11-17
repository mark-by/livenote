# Live Preview

`LivePreviewEditor` — управляемый React-компонент документа. CodeMirror служит внутренним движком: без gutters, IDE toolbar и моноширинного оформления обычного текста. Цвета берутся из семантических переменных HeroUI.

Основной контракт экспортирован из `LivePreviewEditor.tsx` и `index.ts`:

- `source`, `onChange` — единственный исходник документа.
- `renderDiagram(EditorDiagram)` — caller-owned React preview и его controls. Editor не знает pageId, blockId, HTTP, revisions или файловую систему.
- `vimEnabled`, `onVimModeChange` — переключение Vim без пересоздания view, selection и undo history.
- `onContextMenu(EditorContext)` — диапазон под реальным кликом, координаты и descriptor схемы, если клик был внутри widget.
- `onSelectionChange`, `onSave`, `readOnly`, `ariaLabel` — интеграция с оболочкой.
- `onOpenLink(target)` — делегирование открытия Markdown/wiki ссылки оболочке. Обычный клик редактирует текст; Ctrl/Cmd + клик и Ctrl/Cmd + Enter вызывают callback. Проверка цели и навигация принадлежат оболочке; editor сам не вызывает window.open и не назначает непроверенный href.
- `theme` — дополнительный optional `light`/`dark`; палитра остаётся в CSS tokens.
- Ref `LivePreviewEditorHandle`: `focus()`, `getSelection()`, `replaceRange(range, text)`. Замена диапазона — одна обычная операция undo.

`source` echo после `onChange` не создаёт повторной history entry. Внешняя замена меняет только отличающийся диапазон и не записывается как пользовательский ввод. Решение о conflict/discard и отдельном состоянии разных файлов принимает caller.

Поддерживаемые native diagrams: только fenced `mermaid` и локальные Markdown images/reference images/wiki embeds с расширениями `.mmd`, `.mermaid`, `.bpmn`, `.drawio`. Fences `bpmn`/`drawio` остаются обычным кодом. Никаких marker comments или обязательных IDs.

`EditorDiagram.from/to` — `[from,to)` UTF-16 диапазон исходной строки. `source` содержит точный текст Mermaid внутри fence; у внешнего embed он пустой, `target` сохраняет исходную относительную цель. Callback разрешает asset и передаёт существующему viewer актуальный XML/Mermaid. Два одинаковых embeds остаются двумя диапазонами. Ошибки/missing assets показывает caller.

Диаграммы всегда заменяют свой исходный диапазон widget. `StateField` владеет block decorations, `atomicRanges` обслуживает обычную навигацию, transaction filter защищает endpoints при прямых перемещениях Vim. React root сохраняется при обновлении descriptor; `ResizeObserver` запрашивает измерение после асинхронного рендера viewer. Controls widget сохраняют своё управление.

Оформлены заголовки, emphasis/strong, inline code, ссылки, списки и цитаты. Маркеры раскрываются для активного фрагмента. Таблицы и прочие специальные Markdown widgets не добавлены в этой foundation lane.

Layout: документ ограничен читаемой шириной; единственный scroll owner — `.cm-scroller`. Примитив content-limiter: https://github.com/changeroa/StyleGallery/blob/main/patterns/containment/content-limiter.md. Ширина caller host должна быть ограничена; flex/grid parent должен допускать `min-height: 0`.

Проверки:

```sh
node --import tsx --test tests/live-preview-editor.test.ts tests/live-preview-browser.test.mjs
```

Browser tests создают собственный временный Vite harness и профиль Chrome, используют настоящий компонент и закрывают ресурсы. Test fixture diagram — callback proof, не итоговый renderer. Unit fixtures сравнивают точные диапазоны editor с `parseVaultDocument`, включая CRLF, Unicode, identical fences, inline embeds, reference images, escaping и encoded targets.
