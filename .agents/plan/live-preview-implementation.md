# Контракт Live Preview, файлов и встроенных диаграмм

Статус: готов к параллельной реализации. Обязательная область — `live-preview-requirements.md`. Этот документ **заменяет** решения `vault-implementation.md` об обязательных YAML id, UUID в именах, block markers, правой панели свойств, textarea всего документа и запрете открытия диаграммы при несохранённом Markdown. Предыдущий файл остаётся историей. Новых требований к пользователю не добавлять.

Архитектурная задача меняет только этот файл. Production-файлы, package-файлы, пользовательские vault, SQLite и глобальная установка этой задачей не изменяются.

## Проверенные основания

- Прочитаны корневой, server, web и components `AGENTS.md`, требования, предыдущий план, `DESIGN.md`, локальные HeroUI quick-start и Dropdown docs.
- `NoteService` в `src/server/services.ts` уже объединяет REST/MCP, `PageStore` подключает SQLite и `VaultStore`. Сохраняем эти границы.
- `vaultDocument.ts` сейчас требует начальный YAML/id и создаёт маркеры через `materialize`; `VaultStore.createPage` создаёт UUID и YAML. Именно это заменяется, а не маскируется в интерфейсе.
- `VaultFiles` уже проверяет containment/symlinks, ведёт recoverable journal, lock и idempotency receipts. Расширяем его для каталогов; второго файлового писателя нет.
- `VaultStore` уже пересчитывает fingerprint из пути, исходника и XML; watcher + периодическая сверка уведомляют через SSE. Сохраняем механизм.
- `DiagramFullscreen` и `BpmnBlockView` используют `bpmn-js/lib/NavigatedViewer`, **не Modeler**. Сейчас графического BPMN-редактирования нет. Новый dialog использует установленный `bpmn-js/lib/Modeler`; его createDiagram/importXML/saveXML/saveSVG API проверены по текущей документации и установленным source/types.
- `useDiagramEditor` редактирует Mermaid flowchart/classDiagram через существующие модели; `DrawioFullscreen` редактирует локальным iframe через `useDrawioFrame`. Сейчас оба сохраняют напрямую блоковым API.
- `PageView.chooseAddType('drawio')` немедленно создаёт блок. Этот путь непригоден для создания с отменой: новая схема должна жить только в памяти до Save.
- `parseMarkdownToBlocks`/`exportPageMarkdown` пересобирают Markdown. Это interchange legacy SQLite, не путь сохранения файлового документа.
- Существующие `api.ts` маршруты уже кодируют pageId через `encodeURIComponent`; Express может принять encoded slash как часть одного параметра.

## 1. Источник истины и идентичность

Vault — обычные UTF-8 файлы и настоящие каталоги. В vault API значение `page.id` равно `path`: точному root-relative POSIX-пути с расширением. Например, `Работа/Приёмка.md`. Никакого обязательного идентификатора в файле, имени, YAML, комментарии или sidecar-таблице соответствия нет. Два `Приёмка.md` в разных папках — два документа.

Поддерживаемые открываемые файлы: `.md`, `.mmd`, `.mermaid`, `.bpmn`, `.drawio`. Последние четыре — исходники схем; они видны в дереве и выборе существующего файла. Основной сценарий — схема внутри Markdown. Отдельный файл открывается тем же редактором соответствующей схемы, а не становится заменой inline embed.

Простой `Заметка.md` без frontmatter открывается сразу. YAML, если уже есть, остаётся обычным необязательным содержимым: не требуем id, не меняем unknown fields, не добавляем updated при записи. Одинаковые устаревшие YAML id не конфликтуют: идентичность определяется путём. Title для дерева/вкладок — filename stem. Inline rename заголовка оболочки переименовывает файл в текущей папке; существующий `# Заголовок` в тексте не переписывается автоматически. Heading остаётся редактируемой частью Markdown.

Теги извлекаются из `#тег` в прозе вне code/URL; `# Заголовок` не тег. Unicode-буквы/цифры, `_`, `-`, вложенный `/` допустимы; список дедуплицируется. Необязательные старые YAML tags можно читать дополнительно, но новый ввод тегов — текст в документе. Постоянной формы метаданных нет.

Пути API не содержат ведущего `/`, backslash, NUL, drive/UNC, пустых, `.` или `..` компонентов. Служебные `.git` и `.livenote` закрыты. `_assets` старого vault разрешён как обычный каталог схем при чтении/миграции, новые UUID-подкаталоги не создаём. Ссылки могут содержать `..`, только если разрешённый результат внутри vault. Существующие проверки no-follow и реального containment сохраняем. Root нельзя переименовать/удалить. JSON path декодируется ноль раз; URL parameter — один раз транспортом.

## 2. Нативный Markdown и производные диапазоны

Поддерживаемые встраивания:

````markdown
До схемы.

```mermaid
flowchart LR
  Приёмка --> Хранение
```

![Процесс](./Схемы/Приёмка.bpmn)
![[./Схемы/Архитектура.drawio]]
![Обзор](./Схемы/Обзор.mmd)

После схемы.
````

Обычные Markdown image и wiki embed поддерживают все расширения схем. `.mmd`/`.mermaid` содержат чистый Mermaid, `.bpmn`/`.drawio` — точный XML. Markdown reference-style images поддерживаются через definitions. Обычные изображения/ссылки остаются обычным Markdown. Сетевые назначения никогда не загружаются сервером как диаграммы.

Wiki embed `![[target|label]]` использует часть после `|` как подпись, не размер. Destination разрешается **от папки текущего документа**, включая `./` и `../`. У wiki page links `[[target#heading|label]]` то же правило; extensionless `.md` сначала ищется относительно текущей папки, затем точный root-relative путь, затем единственное совпадение filename stem/необязательного alias. Неоднозначность остаётся unresolved. Новые записи генерируют относительный путь с расширением; basename-поиск не используется для записи.

Парсер возвращает диапазоны поверх неизменённой строки; не восстанавливает документ из AST и не использует AST `value` для обратной записи. Диапазоны `[from,to)` — смещения UTF-16 JS строки, а не байты, строки или позиции DOM. LF/CRLF, BOM, fence length, trailing newline, Unicode и пустые строки сохраняются. В UTF-8 bytes переводим только на границе файлового слоя/хеша.

```ts
interface SourceRange { from: number; to: number }
interface VaultSourceSpan extends SourceRange {
  blockId: string;
  type: BlockType;
  sourceFrom: number;
  sourceTo: number;
  assetPath?: string;
}
```

`VaultDocument.spans` идёт в порядке документа и соответствует `page.blocks` один к одному. Markdown runs и Mermaid fence/diagram embed образуют полное непересекающееся покрытие исходника; пустой `.md` имеет ноль spans/blocks. Необязательный frontmatter входит в Markdown run и не исключается из сохранения.

Для Mermaid fence `from/to` охватывают fence, `sourceFrom/sourceTo` — точное содержимое между opening newline и разделяющим closing newline. Для embed `from/to` — image/wiki token без соседнего текста; `sourceFrom/sourceTo` равны `from/to`, XML лежит в asset. Для Markdown source range совпадает с полным range. Для самостоятельного diagram file — один span `[0,source.length)` соответствующего типа, без assetPath.

`Block.id = 'span-' + zeroBasedIndex` — **временный адрес только данной ревизии**, не сохраняется на диск. `Block.pageId = path`. `Block.source` — текст Markdown run, чистый Mermaid или загруженный XML; текущие viewers получают привычный `Block`. В каждом ответе после изменения используем заново полученные IDs; не переносим их на другую ревизию. Render confirmations храним как `(path,revision,blockId)`, не подмешиваем старый render status в новую проекцию.

Два побайтно одинаковых Mermaid fences — два разных range и два разных derived blockId. Их нельзя дедуплицировать, искать через indexOf(source), адресовать content hash или «первое совпадение». UI handle схемы — `(document path, draftEpoch, from, to)`, backend handle — `(path,version,from,to)` либо текущий transient blockId + revision. DraftEpoch — локальный монотонный номер редакторской transaction, не metadata файла. Изменение одного identical fence обязано затрагивать только его range; тест включает два одинаковых fence и редактирование второго.

Диаграммы распознаются вне code/escaped syntax; CommonMark fenced/inline code исключается из wiki/links/tags parsing. Server-authoritative парсер и редактор обязаны иметь одинаковые fixtures диапазонов; web не должен импортировать Node filesystem/parser wrapper. Чистый общий range helper можно вынести в shared, если это сокращает дублирование; обязательного нового parser framework нет.

Missing/invalid external diagram остаётся видимым embed с диагностикой. Текст заметки можно читать и исправлять; XML не раскрывается при движении курсора. Не выдаём старый source как актуальный. При отсутствующем asset `Block.source = ''`, `VaultAsset.source = null`, есть problem; manifest включает факт отсутствия. Ошибка XML показывает ошибку viewer. Сохранять несвязанный текст разрешено; новые/изменённые диаграммы проверяются до публикации.

## 3. Минимальные DTO

Типы лежат только в `src/shared/types.ts`. В существующих `VaultDocument`, `WriteVaultDocumentBody`, `VaultAsset`, `VaultSnapshot` применяем следующие изменения; старые обязательные `blockId` в assets удаляем.

```ts
interface VaultAsset {
  path: string;
  type: DiagramFormat;
  source: string | null;
  version: string | null; // sha256 точных bytes, null = файл отсутствует
}
interface VaultDocument {
  page: PageFull;         // id === path в vault
  path: string;
  source: string;         // точный полный текст самого файла
  version: string;        // sha256 manifest, включает referenced assets
  spans: VaultSourceSpan[];
  aliases: string[];      // необязательные существующие данные, default []
  tags: string[];
  assets: VaultAsset[];  // уникальные пути referenced diagram files
  links: VaultLink[];
  backlinks: VaultBacklink[];
}
interface WriteVaultDocumentBody {
  expectedRevision: number;
  expectedVersion: string;
  source: string;
  assets?: Array<{
    path: string;         // root-relative, не embed-relative
    source: string;
    expectedVersion: string | null; // null строго create-if-absent
    layout?: WriteLayout; // только BPMN, default preserve
  }>;
  references?: Array<{path: string; expectedVersion: string}>;
  requestId?: string;
}
interface VaultSnapshot {
  pages: VaultPageSummary[]; // только .md, совместимый list_pages
  files: Array<{
    path: string;
    kind: 'markdown' | DiagramFormat;
    title: string;
    version: string;
    revision: number;
  }>;
  folders: string[];      // все реальные каталоги, включая пустые, root = ''
  treeVersion: string;    // sha256 путей, типов и точных файловых versions
  tags: Array<{tag: string; count: number}>;
  problems: VaultProblem[];
}
interface MoveVaultPageBody {
  expectedRevision: number;
  expectedVersion: string;
  path: string;
}
interface VaultMoveResult {
  document?: VaultDocument; // присутствует для перемещённого открываемого файла
  moved: Array<{from: string; to: string}>; // каталоги и файлы
  updatedPaths: string[];  // все файлы с переписанными links
  treeVersion: string;
}
```

`VaultLink.targetPageId` и `VaultBacklink.pageId` остаются для совместимости, но в vault их значения — пути. `PageSummary/Block/WriteBlockResult.revision` остаётся number; это непрозрачный fingerprint, только equality. `ApiConfig.storage` продолжает отделять SQLite.

`VaultProblem` больше не использует missing_id/duplicate_page_id как причину недоступности обычного файла. Старые коды можно оставить для диагностики миграции, новый read path их не генерирует. `VaultConflictDetails` сохраняет currentRevision/currentVersion/reason/paths; adds `currentTreeVersion?: string`, `reason: 'missing'` для удалённого draft target. 400 — форма/путь; 404 — обычное чтение отсутствующего файла; 409 — stale/missing/destination_exists/document_problem/transaction_incomplete; 422 diagram_invalid — отвергнутый изменённый diagram source. Ничего не сохраняется при 400/409/422.

Fingerprint использует текущий domain-separated length-prefixed manifest, но deduplicates assets по path и включает тип + missing sentinel. Отдельный diagram file хешируется как основной файл без self-reference. Полный `version` — `sha256:` + 64 hex; numeric revision — существующие 52 бита hash плюс 1. Tree manifest включает реальные каталоги, включая пустые, и все перемещаемые regular files; неизвестные binary files учитываются raw hash, не загружаются как Markdown. Index/mtime/render status/backlinks в токены не входят.

## 4. REST, MCP и один NoteService

Сохраняем действующие envelopes, auth и AppError. `:pageId` в vault — `encodeURIComponent(path)` целиком; пример `/api/pages/Работа%2FПриёмка.md/document` с обычным URL encoding Unicode клиентом. Не вводим обязательного base64/UUID адреса. В SQLite это по-прежнему прежний ID.

| Операция | Контракт |
| --- | --- |
| `GET /api/vault` | `VaultSnapshot`, включая files/folders/treeVersion |
| `GET /api/pages/:pageId/document` | `{document}`; открывает любой поддерживаемый файл |
| `PUT /api/pages/:pageId/document` | `WriteVaultDocumentBody` → `{document}`; один commit source + assets |
| `POST /api/pages` | `{title, path?, source?, requestId?}` → `{page}`; path `.md`; без path — понятный `<safe-title>.md`, при коллизии `<safe-title> 2.md` и далее; пустой source по умолчанию |
| `POST /api/pages/:pageId/move` | `MoveVaultPageBody` → `VaultMoveResult`; файл, rename и move одинаковы |
| `DELETE /api/pages/:pageId` | существующий expectedRevision + необязательный expectedVersion → 204; UI посылает оба |
| `GET /api/search?q=&tag=` | прежний `{hits}`, pageId в hit = path |
| `POST /api/vault/folders` | `{path,expectedTreeVersion}` → `{snapshot:VaultSnapshot}` |
| `POST /api/vault/folders/move` | `{from,path,expectedTreeVersion}` → `VaultMoveResult` |
| `DELETE /api/vault/folders` | JSON `{path,expectedTreeVersion,recursive?:boolean}` → `{snapshot}`; непустая без recursive = 409 |

Создание папки не создаёт placeholder file; новая заметка получает path выбранной папки. Создание с явным path не перезаписывает существующий файл. Первые родительские папки можно создать вместе с заметкой; их создание включено в journal.

Для standalone diagram create без встраивания используем тот же `POST /api/pages` с дополнительным `format: DiagramFormat` и соответствующим расширением path, source обязателен; ответ тот же. Не нужна отдельная asset upload subsystem. Whole-document GET/PUT работает и для него, assets в таком PUT отсутствуют. Существующий выбранный diagram file встраивается без его перезаписи.

`GET /api/pages/:id`, PNG/check/layout/rendered endpoints продолжают работать с derived blocks. Vault export Markdown возвращает точные source bytes, а не `exportPageMarkdown`; export-all сохраняет относительную структуру и referenced diagram files. Import в vault пишет исходный Markdown целиком на новый выбранный path; legacy split/export остаётся в SQLite.

В `NoteService` расширяем существующие getDocument/writeDocument/movePage и добавляем createFolder/moveFolder/deleteFolder. VaultStore остаётся PageStore; parsing/span edits входят в существующие prepare/finish/publish. REST/MCP не работают с fs напрямую.

Существующие MCP имена сохраняем. `page_id` в vault означает path, описания/schema это явно говорят. `add_page` получает optional `path`, `source`; `write_markdown`/`write_diagram` делают `block_id` optional, добавляют optional `at` UTF-16 position и `expected_version`. Переданный `block_id` должен существовать в указанной ревизии; неизвестный `span-*` = 404, не append. Без block_id создаём в `at` или EOF; ответ возвращает **реальный derived block_id**. Старый произвольный create block_id разрешён только SQLite. Это явное изменение vault-семантики, не обещание сохранить невидимый постоянный ID.

Добавляем MCP `get_document {path}`, `write_document {path,expected_revision,expected_version,source,assets?,references?,request_id?}`, `create_folder {path,expected_tree_version}`, `move_folder {from,path,expected_tree_version}`, `delete_folder {path,expected_tree_version,recursive?}` и `move_document {path,to,expected_revision,expected_version}` как тонкие NoteService wrappers. assets/references snake_case `expected_version` преобразуется в camelCase DTO. `get_document` возвращает тот же VaultDocument, `write_document` тоже. `list_pages/get_page/update_page/delete_page/check_diagram/layout_diagram` сохраняют envelopes. Для дерева агенты получают новый `get_vault` без аргументов → snapshot. Все инструменты в SQLite с vault-only входами возвращают vault_required.

`update_page.title` в vault делает filename rename и link rewrite. Block delete/reorder заменяет только spans текущей ревизии без materialize. Mermaid title хранится обычным соседним Markdown heading при явном задании title; embed title — alt/wiki label. Для уже существующей inline Mermaid heading не становится служебным владельцем block: удаление схемы не удаляет произвольный соседний heading. При изменении title MCP используется вставка нового heading непосредственно перед fence; прежний отдельный heading не угадывается/не удаляется.

## 5. Атомарная вставка и изменение схемы

**Сначала память, потом один Save.** Открытие меню, выбор типа, загрузка seed, редактирование, iframe autosave и Cancel не вызывают mutations. Начальные Mermaid flowchart, BPMN с минимальным process и draw.io XML — константы в клиенте, не временные файлы.

Контекстное меню получает позицию через editor coordinates, а не selection последнего клика. Пустая область ниже текста = `source.length`. Внутри обычного prose вставляем перед текущей строкой с необходимыми newline, не рвём link/code token. Внутри diagram widget открывается отдельное меню схемы. Клавиатурная/мобильная кнопка использует текущую selection head. Native Cut/Copy/Paste остаются доступны; custom menu не перехватывает clipboard shortcuts или контекст iframe/input.

На время dialog редактирование основного Markdown блокируется через readOnly, поэтому captured source range не устаревает локально. Сохраняемый candidate содержит весь актуальный Markdown draft, включая ещё не autosaved prose. Async autosave текущего файла сначала дожидается результата; modal захватывает последнюю подтверждённую baseVersion и текущие draft source/epoch/range. Это не значит автоматически сохранять несохранённый текст при открытии dialog: ждём только уже отправленный запрос. Пока modal открыт, autosave этого документа приостановлен. Другие вкладки могут сохраняться.

Mermaid по умолчанию вставляется fenced code в точную source-позицию. BPMN/draw.io по умолчанию создают понятный соседний файл: `Схемы/<stem заметки> — Процесс.bpmn` или `… — Диаграмма.drawio`, коллизии ` 2`, ` 3`; без UUID. File picker может задать другое допустимое место/имя. Candidate Markdown содержит обычный относительный embed. В PUT assets entry содержит root-relative path, source и expectedVersion:null. Сервер проверяет отсутствие назначения, refs/type, валидирует диаграммы, затем коммитит заметку и новый файл одной транзакцией.

При embed существующего файла assets entry отсутствует. Чтобы исключить гонку выбора файла, PUT добавляет optional `references?: Array<{path:string;expectedVersion:string}>`: только newly added existing references, immutable guards, не запись. Исчезнувший/изменившийся выбранный файл = 409. Для неизменённых старых references достаточно base manifest.

Редактирование existing embedded file, включая Mermaid `.mmd`/`.mermaid`, использует assets replacement с захваченным asset version; меняет **общий файл**, поэтому все embeddings получают обновление и SSE. Формат встраивания не меняется: embed Mermaid не заменяется inline fence при Save. UI прямо показывает путь файла в dialog. При удалении embed файл остаётся на диске; удаления diagrams через дерево — явные отдельные операции. Ссылки на удалённый файл становятся unresolved.

Для BPMN `layout:auto` вызывает существующий bpmnValidator.layout до commit; preserve требует BPMNDI для новой/изменённой схемы, как действующий writeBpmn. Modeler.createDiagram даёт starter с DI; обычное graphical save использует preserve. Возвращается фактический XML после layout. Неизменённый файл не переформатируется. Ordinary Markdown save не делает скрытой автораскладки.

Успех PUT возвращает фактический document. Оболочка одной editor transaction применяет inserted range, обновляет base tokens и список assets. Cancel не меняет editor history и selection; Save/undo вставки является одной операцией истории Markdown. Undo после сохранения удаляет embed при следующем autosave, но не уничтожает файл схемы.

## 6. Независимый frontend seam

Editor foundation lane `st_01a1e65e` владеет только новыми `src/web/editor/**` и `tests/live-preview-*`. Его ранний browser proof Live Preview + diagram widget + Vim toggle — gate до массовой интеграции. Dependencies lane `st_01a1e65d` единственный меняет package.json/package-lock.json. Editor не знает pageId/blockId, HTTP, revisions, файловую систему или DTO хранилища.

Публичный export `src/web/editor/LivePreviewEditor.tsx`:

```ts
type EditorDiagram = {
  from: number; to: number;
  format: 'mermaid' | 'bpmn' | 'drawio';
  source: string;             // fence source; для embed '' до resolution shell
  target?: string;            // raw relative embed destination
  label?: string;
};
type EditorContext = {
  from: number; to: number;
  clientX: number; clientY: number;
  diagram?: EditorDiagram;
};
interface LivePreviewEditorProps {
  source: string;
  onChange(source: string): void;
  renderDiagram(diagram: EditorDiagram): React.ReactNode;
  vimEnabled?: boolean;       // default false
  onVimModeChange?(mode: 'normal' | 'insert' | 'visual'): void;
  onSave?(): void;
  onContextMenu?(context: EditorContext): void;
  onSelectionChange?(range: SourceRange): void;
  onOpenLink?(target: string): void; // Cmd/Ctrl-click; обычный click редактирует Markdown.
  readOnly?: boolean;
  ariaLabel?: string;
}
interface LivePreviewEditorHandle {
  focus(): void;
  getSelection(): SourceRange;
  replaceRange(range: SourceRange, text: string): void;
}
```

`source/onChange` — единственное состояние документа. `replaceRange` вызывает обычную editor transaction, сохраняет undo/redo и вызывает onChange; контролируемый source echo не создаёт второй history entry. Внешняя замена source допустима только при clean draft либо явном discard. Родитель не пересоздаёт editor при каждом keypress, сохранении или Vim toggle; changing document path создаёт/восстанавливает отдельный editor state. Source prop alone не означает разрешение стереть draft.

`renderDiagram` синхронно возвращает widget; shell разрешает target по текущему path и assets и передаёт diagram adapter source/range. Adapter использует существующие viewers с синтетическим Block из текущих ranges. Никаких backend IDs в editor callback. Повторные идентичные widgets не remount при движении курсора; distinct ranges не сливаются в один widget. Диаграмма всегда widget; cursor adjacency не раскрывает XML. Mermaid раскрывается для редактирования только отдельным действием схемы, существующий visual flowchart/class редактор сохраняется.

Для Mermaid вне существующих визуальных моделей, например sequenceDiagram, действие редактирования открывает исходник схемы с preview. Иначе после замены fence на атомарный widget пользователь теряет возможность править существующую схему. Редактор исходника относится только к выбранной диаграмме, не раскрывает служебные данные документа и сохраняет общий onCommit/Cancel контракт.

Markdown/wiki links открываются по Cmd/Ctrl-click через `onOpenLink(target)`. Оболочка разрешает target по текущему документу и серверным links; опасные протоколы не исполняются. Обычный click ставит курсор и раскрывает синтаксис. Редактор не выполняет HTTP и не угадывает page IDs.

Context/range offsets используют тот же UTF-16 контракт, что сервер; при virtualized viewport позиции вычисляются editor API. Editor callback не запускает Save и не создаёт файл. Оболочка может сохранить range и передать новый Markdown через контролируемый source, но для успешной локальной вставки предпочитает replaceRange ради единого undo.

Обычные viewers сохраняют существующие props и получают additive `persisted?: boolean` (default true). При false не вызывают confirmRendered и не предлагают server PNG текущего draft; локальные SVG/copy продолжают работать. Только snapshot, byte-identical текущему draft и его assets, может иметь persisted:true. Numeric `< revision` в stale badges заменяется на `!==`.

Для `DiagramFullscreen`, `DrawioFullscreen`, `useDiagramEditor` additive:

```ts
onCommit?: (source: string, options?: {layout?: WriteLayout}) => Promise<void>;
initialEditing?: boolean; // для create/edit Mermaid, без промежуточной записи
```

При onCommit запись делегируется оболочке: await → успех; exception → dialog/draft остаются. Без callback legacy SQLite идёт существующим updateBlock путём. Не копируем протокол draw.io, модели flowchart/class или экспорт. Drawio save по-прежнему получает свежий XML через exportDiagram('xml',true), не последнее autosave message. onSaved legacy callback остаётся совместимым; новый shell использует onCommit, затем собственный document result.

BPMN получает **графический fullscreen editor на `bpmn-js/lib/Modeler`**, а inline preview сохраняет существующий NavigatedViewer. На create вызывается `modeler.createDiagram()`, на edit — `modeler.importXML(source)`; palette/context pad позволяют создавать task/event, соединять, переименовывать и двигать элементы. Modeler живёт один раз на dialog, при unmount вызывается destroy. Перед Save завершается активное label editing, затем `saveXML()` возвращает свежий XML для injected callback; `saveSVG()` сохраняет локальный экспорт. `commandStack.changed` отмечает dirty, но не пишет файл/Markdown. Автораскладка — отдельное явное действие через существующий validator, не необходимость при обычном Modeler save. XML-редактор может быть дополнительным advanced действием; **не единственным BPMN UX**.

Если в existing dialog нет изменения, Save/Close возвращает исходный source без round-trip serialization. Для Modeler import events не считаются пользовательскими edits. Create всегда требует явного Save, даже если starter не изменён. Это сохраняет bytes/no-op и не создаёт файл на Cancel.

Keyboard установленной diagram-js версии привязан к canvas SVG автоматически; не передавать устаревший keyboard.bindTo. Markdown Vim/shortcuts не обрабатывают события внутри Modeler/dialog. Palette, создание task/connection, label edit, drag, undo/redo и Save/Cancel проверяются реальным browser сценарием, а не только XML API. До появления этого пути нельзя писать, что прежний NavigatedViewer уже редактировал BPMN.

### Diagram adapter lane

Отдельная задача владеет **existing diagram components/fullscreen/hooks** и только новыми `src/web/diagrams/**`. Shell владеет `src/web/vault/**`; foundation — `src/web/editor/**`. Адаптер не создаёт второй preview engine: он выбирает MermaidBlockView/BpmnBlockView/DrawioBlockView, прежние fullscreen editors и новый Modeler dialog.

Публичные экспорты в `src/web/diagrams/index.ts`:

```ts
interface DiagramValue {
  format: DiagramFormat;
  source: string;
  title?: string;
}
interface DiagramSession {
  value: DiagramValue;
  mode: 'create' | 'edit' | 'view';
  key: string; // shell генерирует из path/draftEpoch/range
}
interface DiagramPreviewProps {
  value: DiagramValue;
  onExpand(): void;
  onEdit(): void;
  // Только для source, точно соответствующего saved snapshot.
  persisted?: {pageId: string; blockId: string; revision: number};
}
interface DiagramDialogProps {
  session: DiagramSession;
  onSave(value: DiagramValue, options?: {layout?: WriteLayout}): Promise<void>;
  onCancel(): void;
  persisted?: {pageId: string; blockId: string; revision: number};
}
// DiagramPreview(props), DiagramDialog(props)
```

Adapter onSave не обновляет server revision, не угадывает позицию и не вызывает HTTP. Shell замыкает immutable transaction context:

```ts
interface DiagramDocumentContext {
  path: string;
  baseRevision: number;
  baseVersion: string;
  draftEpoch: number;
  draftSource: string;
  range: SourceRange; // create: from === to; edit: точный embed/fence range
  originalRangeSource: string;
  asset?: {path: string; version: string | null};
}
```

До Save shell сверяет path/draftEpoch и `draftSource.slice(from,to) === originalRangeSource`; локальное несовпадение оставляет dialog и показывает конфликт, а не ищет похожую схему. Он строит один candidate source заменой ровно этого диапазона (inline Mermaid), или сохраняет unchanged embed и assets replacement (любой embedded format), или добавляет embed+new asset (create). Один writeDocument с captured baseRevision/baseVersion и asset expectedVersion коммитит всё; returned actual document становится base. Модальный range не ищется через временный server blockId. Standalone file использует range всего source и тот же PUT.

Rejected onSave сохраняет Modeler/iframe/Mermaid draft. onCancel уничтожает только локальный session и возвращает focus/selection; после открытия dialog до Save нет mutations, включая скрытые createBlock. В legacy SQLite существующие компоненты без injection продолжают прежний updateBlock; новые adapters используются vault shell, но рендер/экспорт/visual logic не копируются. Опциональные onCommit существующих компонентов — мост в DiagramDialog, не ещё один transaction слой.

Vim off по умолчанию, localStorage setting; Normal/Insert/Visual в строке состояния. Toggle через compartment/reconfiguration, без пересоздания editor, потери source/selection/history. Key bindings Vim действуют только в Markdown editor; visual diagram dialogs и iframe сохраняют своё управление.

## 7. Autosave, внешние изменения и файл/папка

Оболочка держит per-path `{source,baseRevision,baseVersion,changedAssets,selection,dirty}` независимо от свежего snapshot. Autosave debounce 500 мс, один in-flight save на документ. Cmd/Ctrl+S немедленно использует тот же save path. Если пока запрос выполнялся введён новый текст, успех меняет только base tokens; более новый draft не заменяется ответом и сохраняется следующим запросом. При no-op нет записи/mtime/SSE.

SSE clean → перечитать; dirty/modal/in-flight → отметить external conflict, не менять draft/base tokens. Сначала сверить собственный pending request/result, чтобы SSE собственного commit не пометил конфликт. На 409 остановить autosave данного draft, оставить Markdown + XML + selection/history, показать reload/discard и copy/download draft. Автоматической перезаписи свежими tokens нет. Delete/rename снаружи оставляет dirty draft по старому path с reason missing; никаких inode/UUID догадок о новом имени.

Сервер сверяет disk manifest перед prepare, после await validation и непосредственно перед заменами. Existing lock/journal/receipts сохраняются. Recover никогда не перезаписывает неизвестную третью версию файла. Честная гарантия — обнаруженные внешние edits дают 409; filesystem не предоставляет транзакцию с произвольным внешним редактором после последнего check. SSE публикуется только после commit.

Rename/move из приложения переводит все paths subtree, outgoing relative destinations и resolved incoming Markdown/wiki/embed destinations. Rewrite только destination ranges/definitions, сохраняя labels/fragments/encoding, текст, комментарии и line endings. Для incoming links двигаем target; для outgoing links двигаем base; для folder move применяем одну таблицу old→new. Alias/basename ссылки, которые были однозначно resolved и перестали бы быть такими, заменяем явным относительным path с прежним label. Unresolved links не угадываем. Links внутри code не трогаем.

Файлы схем могут разделяться заметками: move/rename схемы обновляет все embeddings. Move note не двигает чужие/общие diagrams, только переписывает её относительные ссылки. Folder move переносит subtree, включая пустые папки и неизвестные binary файлы побайтно; symlinks запрещены. Case-insensitive collisions на хосте = 409; case-only rename выполняется journaled staging rename. Folder move в собственный subtree = 400.

Folder create/move/delete проверяет expectedTreeVersion и versions затронутых файлов; commit journal включает directory create/rename/removal и link writes. Empty folders нельзя восстанавливать из списка notes — нужны directory entries в journal. Recursive delete явно подтверждается UI и переносит subtree в существующую trash, не удаляет схемы за пределами subtree; входящие ссылки остаются unresolved. New directory/file publication никогда не overwrites destination. Generic binary bytes не проходят через UTF-8 decoder.

После app move shell применяет `moved` к tabs/history/drafts и selection. Перед move с dirty затронутым документом сначала сохранить или явно отменить действие; не переносить dirty drafts тихо. External move представлен delete/create; clean tabs могут закрыться/показать missing. Это следствие path identity.

SSE добавляет `vault.updated` для folders/tree и `page.moved` с optional `previousPath`; в vault у обычных page events pageId=path, у diagram file тоже path. Для app folder move `moved` HTTP result авторитетен; SSE invalidates snapshot. Events для всех notes, чьи manifests изменились через shared diagram, обязательны. Reconnect перечитывает snapshot и clean documents, сохраняя dirty drafts.

## 8. CLI, legacy и безопасный перенос

Явный `--db`/LIVENOTE_DB сохраняет существующий SQLite adapter, stable UUID/block IDs, numeric increment revisions и блоковый UI как legacy режим. Default — vault, `--vault` — path mode. Оба явных storage selectors вместе = ошибка. Текущий dbPath-only `createApp` остаётся SQLite для существующих tests/embedders. Автоматической миграции при serve/read нет.

Два явных offline режима:

```text
livenote migrate --db <исходная-SQLite> --vault <новый-каталог>
livenote migrate --from-vault <старый-vault> --vault <новый-каталог>
```

Назначение только отсутствующее либо пустое, вне source subtree. Не работать на реальном user vault. Stage рядом с назначением → проверка → atomic directory rename. Source vault копируем read-only byte-for-byte во staging, включая пустые каталоги/обычные assets, кроме operational locks/cache; symlinks отвергаем. Исходный `.livenote` recovery при наличии unfinished journal — явная ошибка с просьбой сначала восстановить source, не скрытое восстановление источника.

Старый vault: отдельный migration-only parser понимает прежние YAML id/markers/framingNewline. Он читает original bytes, строит plain Markdown, убирает только известные служебные fields/markers, сохраняет user YAML/unknown keys/comments и exact diagram source. UUID filenames переводит в `<title>.md` с ` 2` коллизиями; `_assets/<id>/...` переводит в понятные `Схемы/<note stem> — <diagram title или type N>.<ext>`. Полная old path/id→new path карта строится **до** записи и переписывает ID/wiki/Markdown/embed links; нераспознанный legacy marker — migration error, не guessed conversion.

SQLite: получить consistent read-only snapshot, не модифицировать source DB/WAL/SHM. Для WAL источника сначала побайтная offline copy DB/WAL/SHM в staging при неизменных source hashes, открыть уже копию и получить snapshot; изменившийся during-copy source = ошибка, без retry/записи источника. Сохранять source всех блоков: Markdown concatenation с минимальными separators, Mermaid fences подходящей длины, XML отдельными файлами, title обычным heading/alt. Block source без завершающего newline остаётся исходными bytes внутри migration archive; plain Markdown не обещает сохранить устаревшие block boundaries.

Во staging migration archive `.livenote/migration/` содержит manifest old IDs/paths/timestamps/deleted status и **полные исходные bytes** legacy vault либо SQLite snapshot + block source records. Это архив происхождения, не runtime identity map: его удаление не ломает файлы, links или revision. Deleted pages помещаются в trash с теми же plain форматами, не появляются активными. Не переносим stale render status/receipts. Manifest фиксирует destination paths и checksums; проверка сравнивает все диаграммы byte-for-byte и исходный архив. Unknown source format не переписывать молча.

Миграционный proof выполняется на fixtures: source tree + SQLite DB/WAL/SHM hashes до/после одинаковы; destination открывается без YAML/id/markers; переименование из приложения обновляет links; plain source и XML не пропали. UUID могут оставаться только как исторические данные архива или пользовательский текст, не новый native address.

## 9. Порядок реализации и границы правок

1. **Dependencies** (`st_01a1e65d`): только package.json/package-lock.json, фактические editor/Vim/icons зависимости после раннего proof; существующие HeroUI/Tailwind не переустанавливать без причины.
2. **Editor foundation** (`st_01a1e65e`): только новые `src/web/editor/**`, `tests/live-preview-*`; экспорт props/handle выше; ранний реальный browser proof source editing + widget + Vim toggle. До успешного proof остальная UI интеграция не размножает editor код.
3. **Backend/shared**: `src/server/**`, `src/shared/types.ts`, backend-owned targeted tests. Первым increment — DTO + path parser + GET/PUT/create, уведомить shell о готовности; затем atomic asset commit, filesystem folders/moves/link rewrite, MCP и migration. Один владелец shared types; UI не пишет собственные DTO.
4. **Shell/document integration**: `src/web/App.tsx`, api/events, sidebar/tabs, `src/web/vault/**` и shell styles. Он владеет draft/autosave/conflict/menu/path transforms и renderDiagram; использует DiagramPreview/DiagramDialog. Не изменяет foundation, diagram components или `src/web/diagrams/**`; callback изменения согласовать с владельцем.
5. **Diagram adapter**: существующие `src/web/components/DiagramFullscreen.tsx`, `DrawioFullscreen.tsx`, `useDiagramEditor.ts`, `DiagramEditorPanel.tsx`, `MermaidBlockView.tsx`, `BpmnBlockView.tsx`, `DrawioBlockView.tsx`, `useDrawioFrame.ts`, относящиеся к ним editor styles и новые `src/web/diagrams/**`. Один владелец добавляет onCommit/persisted, source-only adapters и Modeler dialog, сохраняя SQLite default save paths. Он не редактирует shell `src/web/vault/**`, foundation `src/web/editor/**`, api.ts или shared types и не копирует viewers. Отдельные targeted diagram tests согласовываются с coordinator, не захватывают foundation `tests/live-preview-*`.
6. **Coordinator** согласует фактические worker ownership до production edits, принимает shared contract, запускает integrated evidence и фиксирует screenshots. Baseline — root `artifacts/live-preview/baseline.diff` и `status.log`; не откатывает прежние/user изменения.

## 10. Приёмка и существенные риски

Проверять только targeted parser/store/API/migration/editor cases; полный suite не запускать без отдельного разрешения. После proof нужны server/shared и отдельные web typechecks, build, реальные HTTP/MCP и browser use, CLI package/global prefix в собственном temp. Файл контракта не является свидетельством прохождения этих проверок.

Обязательные сценарии:

- Plain Markdown без YAML и UUID; одноимённые документы в двух папках; реальные empty nested folders.
- Unicode/CRLF/ranges, fences-in-fences, escaped syntax, reference links, inline tags; no-op сохраняет bytes и mtime.
- Вписывание текста как Live Preview, local markers только активного фрагмента, undo/redo и Cmd/Ctrl+S.
- Вставка в середину и EOF каждого Mermaid/BPMN/draw.io; Cancel каждого не создаёт files и не меняет документ. Existing file embed; Save создаёт diagram и embed вместе.
- Visual Mermaid flowchart **и classDiagram**, visual draw.io, фактическое BPMN Modeler create/task/connect/rename/drag/save + preview + explicit auto layout, fullscreen/copy/SVG/PNG/source export на inline surface.
- External note/asset change во время dirty draft и validation await → 409, source/XML draft сохраняются, autosave не перезаписывает внешнюю версию.
- Note/diagram/folder move, relative outgoing/incoming embeds/wiki/Markdown/reference definitions, shared asset updates; recursive trash и empty-folder recovery.
- Vim default/toggle/mode/selection/history и отсутствие перехвата visual diagram keys.
- Desktop/mobile light/dark screenshots: документ занимает центр, нет постоянной metadata панели/textarea, меню доступно клавиатурой и пальцем.
- Fixture-only migration обоих legacy источников и isolated packaged CLI; cleanup собственных серверов/браузеров/temp.

Риски с определённым решением: temporary span IDs требуют reread после каждой записи; поэтому новые клиенты работают source/version, legacy block IDs не объявляются stable в vault. Multi-file commit с внешними writers не может обещать filesystem CAS после final check; сохраняем journal/третьи версии. Source-only модель не хранит старые SQLite block boundaries — raw archive сохраняет provenance без обязательной metadata. Existing Mermaid visual editing охватывает текущие flowchart/class модели: не обещать графический редактор произвольного Mermaid-синтаксиса и не регрессировать эти две поддержанные модели.

Выбор: используем path + plain source + derived spans вместо persistent marker identity и вместо полной замены viewers rich-text framework. Это минимально сохраняет текущие NoteService/валидацию/export/visual editors и делает внешний Markdown нативным. Никакой постоянной базы, синхронизирующей Markdown с копией документа, нет.
