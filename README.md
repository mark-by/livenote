# LiveNote

Локальный визуальный блокнот для совместной работы с AI-агентом. Агент создаёт и обновляет
страницы (Markdown + диаграммы Mermaid, BPMN и draw.io) через MCP-инструменты, вы наблюдаете изменения
в браузере в реальном времени, а результат остаётся у вас в обычном Markdown.

```
Агент ── MCP ──► LiveNote ◄── HTTP-команды ── UI
                   │
                   ├── события обновлений (SSE) ──► UI
                   ├── Markdown vault (или явный SQLite-режим)
                   └── проверка Mermaid (headless Chromium, опционально)
```

## Запуск

```bash
make run      # запуск (без пересборки)
make build    # сборка (npm install при необходимости)
make run      # затем запуск с открытием браузера
```

### Глобальная установка (команда `livenote` из любого места)

```bash
make install-global   # сборка + npm pack + npm i -g
livenote --open       # из любого каталога
livenote --help       # справка по опциям
```

Обновление — просто `make install-global` снова (перезапишет предыдущую версию).

Или вручную:

```bash
npm install
npm run build
npx playwright install chromium   # опционально: серверная проверка Mermaid-синтаксиса
node bin/livenote.js --open       # или: npm start
```

Перед сборкой `npm prebuild` готовит локальные ассеты draw.io v32.6.10. Если проверенные
ассеты уже есть, повторная загрузка не нужна. Они входят в собранный пакет, поэтому
установленный LiveNote не загружает редактор или другие ресурсы draw.io из сети.
Локальный self-hosted embed является проверенным поведением проекта, а не официально
поддерживаемым способом развёртывания draw.io embed.

Другие цели Makefile: `make serve` (без браузера), `make smoke` (интеграционная
проверка), `make typecheck`, `make clean`, `make dev-server` / `make dev-web`.

CLI-флаги: `--port` (по умолчанию 4317), `--open` (открыть браузер), `--vault <путь>`
(по умолчанию `~/.livenote/vault`), `--db <путь>` (явный прежний SQLite-режим),
`--theme <имя>` (тема mermaid для
диаграмм, по умолчанию `default`; допустимые: `base`, `dark`, `forest`, `neutral`,
`neo`, `neo-dark`, `redux`, `redux-dark`, `redux-color`, `redux-dark-color`).
Переменные окружения: `LIVENOTE_PORT`, `LIVENOTE_VAULT`, `LIVENOTE_DB`, `LIVENOTE_TOKEN`, `LIVENOTE_THEME`.
Явный `--vault` или `--db` имеет приоритет над обеими переменными хранения.
Два флага хранения или две заданные переменные без флага — ошибка.

### Markdown vault и миграция

```bash
livenote --vault ./notes --open
livenote --db ./legacy.sqlite
livenote migrate --db ./legacy.sqlite --vault ./migrated-notes
livenote migrate --from-vault ./old-notes --vault ./migrated-notes
```

Миграция требует явных источника и назначения вне исходного дерева; назначение
должно отсутствовать или быть пустым. SQLite, WAL и SHM сначала копируются побайтно;
SQLite открывает только копию. Исходный vault читается без lock, записи и recovery.
Соседний staging проверяется и атомарно становится новым vault. Источник остаётся
неизменным. Незавершённый журнал старого vault нужно восстановить до миграции.
В `.livenote/migration/` сохраняются исходные bytes, старые ID, timestamps,
статус удаления, block sources и manifest происхождения. Этот архив не нужен
для открытия новых файлов. Удалённые страницы находятся в `.livenote/trash/migration`.
Старые ревизии, подтверждения рендера и request receipts не переносятся.
Автоматической миграции при запуске или чтении нет.

Путь с расширением определяет документ: `Работа/Приёмка.md` и
`Личное/Приёмка.md` независимы. Обычный Markdown открывается без YAML, ID и
служебных комментариев. Необязательный существующий YAML остаётся частью исходника.
Название в дереве берётся из имени файла; переименование не меняет `# Заголовок`.
Теги пишутся как `#тег` в тексте; существующие YAML `tags` и `aliases` читаются.
Поддерживаются настоящие вложенные и пустые папки.

Mermaid хранится в fenced-блоках либо `.mmd`/`.mermaid`; BPMN и draw.io —
в обычных `.bpmn`/`.drawio` файлах с понятными именами, например
`Схемы/Приёмка — Процесс.bpmn`. Встраивания — `![Процесс](./Схемы/Процесс.bpmn)`
или `![[./Схемы/Архитектура.drawio|Архитектура]]`; пути считаются от текущей заметки.
Reference-style images также поддерживаются. Сетевые ресурсы сервер не загружает.
Файл схемы можно открыть отдельно. Удаление embed не удаляет общий файл схемы.
Добавляйте заметки и схемы в Git. LiveNote создаёт `.livenote/.gitignore`
для приватного состояния и не меняет ваш корневой `.gitignore`.

Файлы являются источником истины. Чтение и сохранение без изменений не переписывают
Markdown/XML и не меняют mtime. Неизвестные YAML-свойства, комментарии и окончания
строк и BOM сохраняются. Отсутствующая схема остаётся embed с диагностикой,
а несвязанный текст можно сохранять. Новые и изменённые схемы проверяются до
публикации. Конфликт Git изолирует только соответствующий документ.

Один процесс LiveNote владеет writer lock. Изменения публикуются через fsync,
журнал с предыдущими/новыми байтами и отдельные atomic rename; при перезапуске
узнаваемые незавершённые записи восстанавливаются. Если обнаружены посторонние
байты, они сохраняются вместе с журналом в `.livenote/transactions`, а документы
изолируются до ручного восстановления. `.livenote/cache` можно удалить без потери
заметок, ID, токенов свежести и 24-часовых receipts в `.livenote/requests`.
Внешние редакторы не соблюдают lock: изменения, видимые при проверках свежести,
вызывают 409, но переносимые файловые API не исключают гонку после последней
проверки. Журнал и повторная проверка перед каждым rename ограничивают последствия;
безусловный compare-and-swap между произвольными внешними процессами не обещается.
Символические ссылки и выход за пределы vault запрещены.

### Vault REST API

Все маршруты ниже используют обычную `/api` аутентификацию. В SQLite они возвращают
409 `vault_required`. Старые REST/MCP операции блоков работают в обоих режимах.

| Маршрут | Результат |
|---|---|
| `GET /api/vault` | `{pages, files, folders, treeVersion, tags, problems}` |
| `GET /api/pages/:id/document` | `{document}`: полный Markdown, assets, links, backlinks |
| `PUT /api/pages/:id/document` | `{document}` после проверки полного документа |
| `PATCH /api/pages/:id/metadata` | `{document}`, `title` переименовывает файл |
| `POST /api/pages/:id/move` | `{document, moved, updatedPaths, treeVersion}` |
| `POST /api/vault/folders` | `{path, expectedTreeVersion}` → `{snapshot}` |
| `POST /api/vault/folders/move` | `{from, path, expectedTreeVersion}` → move result |
| `DELETE /api/vault/folders` | `{path, expectedTreeVersion, recursive?}` → `{snapshot}` |
| `GET /api/export/all.zip` | ZIP с относительными путями, bytes и пустыми папками |
| `GET /api/search?q=...&tag=...` | `{hits}`, до 100 совпадений; точный tag, AND-поиск слов |

В URL параметр `:id` кодируется целиком через `encodeURIComponent(path)`.
`POST /api/pages` принимает `{title, path?, source?, format?, requestId?}` → `{page}`.
Без path получается `<title>.md`, при коллизии `<title> 2.md`; source по умолчанию пуст.
Для standalone diagram задайте format, расширение и source.
PUT принимает `{expectedRevision, expectedVersion, source, assets?, references?, requestId?}`.
Asset: `{path, source, expectedVersion, layout?}`; null version строго означает
create-if-absent. Reference: `{path, expectedVersion}` — проверка выбранного existing
asset без записи. Source и assets публикуются одним journaled commit.
Metadata aliases/tags редактируются в самом исходнике, Move принимает оба токена и path.
Непустая папка требует `recursive:true`; удаление переносит subtree в trash.

В vault `revision` — непрозрачный положительный fingerprint, а `version` —
полный `sha256:` токен Markdown, пути и всех используемых XML. Их нужно возвращать
как прочитаны, не увеличивать и не сравнивать по величине. В SQLite ревизии
сохраняют прежнюю инкрементальную семантику. 409 `conflict` возвращает актуальные
токены/диагностику, 400 — некорректную структуру, 422 `diagram_invalid` — ошибку
изменённой диаграммы. Черновик при конфликте остаётся у клиента.

Wiki page links разрешаются от текущей папки, затем по точному root-relative пути,
затем по единственному filename stem/alias. Неоднозначные ссылки остаются unresolved.
Rename/move переписывает только destinations разрешённых Markdown/wiki/embed links
и reference definitions, включая общие файлы схем. Код не переписывается.
`document.spans` покрывают исходник диапазонами UTF-16 `[from,to)` без пересборки AST;
`span-0`, `span-1` — временные адреса только данной ревизии, на диск не записываются.
Нативный export одной заметки возвращает точный source; export-all — ZIP.
В явном SQLite-режиме сохраняются stable page/block IDs, прежние ревизии и export.

MCP `page_id` в vault означает path. `get_document`, `write_document`, `get_vault`,
`create_folder`, `move_folder`, `delete_folder`, `move_document` вызывают тот же
NoteService. В `write_markdown`/`write_diagram` block_id можно опустить для вставки
в UTF-16 `at` или EOF; переданный span ID должен существовать в expected_revision.
Запись возвращает фактический blockId новой проекции. Для freshness передавайте
`expected_version`; snake_case asset/reference поля MCP преобразуются в тот же DTO.

## Подключение MCP-агентов

Предварительно запустите сервер (`livenote`, `make serve` или `make run`) — агенты
подключаются к `http://127.0.0.1:4317/mcp` (Streamable HTTP).

### opencode

Глобальный конфиг `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "livenote": {
      "type": "remote",
      "url": "http://127.0.0.1:4317/mcp",
      "enabled": true
    }
  }
}
```

Перезапусти opencode — конфиг читается только при старте.

### Claude Code

```bash
claude mcp add --transport http livenote http://127.0.0.1:4317/mcp
```

`--scope user` ставит подключение глобально (по умолчанию — в текущий проект).
Проверка: `claude mcp list`.

### Codex

Глобальный конфиг `~/.codex/config.toml`:

```toml
[mcp_servers.livenote]
url = "http://127.0.0.1:4317/mcp"
```

### Аутентификация (опционально)

Если сервер запущен с `LIVENOTE_TOKEN`, агенты обязаны передавать
`Authorization: Bearer <токен>`:

- **Codex**: `bearer_token_env_var = "LIVENOTE_TOKEN"` в секции сервера
- **Claude Code**: `claude mcp add ... --header "Authorization: Bearer ${LIVENOTE_TOKEN}"`
- **opencode**: `"headers": { "Authorization": "Bearer {env:LIVENOTE_TOKEN}" }` в записи `livenote`

## MCP-инструменты

| Tool | Назначение |
|---|---|
| `list_pages` | Список страниц: ID, название, ревизия, время изменения |
| `get_page` | Прочитать страницу, её блоки и текущую ревизию |
| `add_page` | Создать страницу (идемпотентно по `request_id`) |
| `write_markdown` | Создать/полностью заменить Markdown-блок |
| `write_diagram` | Создать/заменить диаграмму: Mermaid (`format: "mermaid"`), BPMN XML (`format: "bpmn"`) или draw.io XML (`format: "drawio"`) |
| `check_diagram` | Проверить блок: `syntax` (parse; для BPMN — moddle + bpmnlint) или `render` (полный рендер, только валидация без изображений; PNG для человека — REST `GET /pages/:pageId/blocks/:blockId/png`) |
| `layout_diagram` | Пересчитать раскладку BPMN-блока (bpmn-auto-layout) |
| `update_page` | Переименовать страницу, изменить порядок/удалить блоки |
| `delete_page` | Удалить страницу (в корзину) |

### BPMN

`write_diagram` с `format: "bpmn"` принимает BPMN 2.0 XML:

- **`layout: "preserve"`** (по умолчанию) — используется геометрия BPMNDI из XML;
  без неё публикация отклоняется с подсказкой.
- **`layout: "auto"`** — раскладка пересчитывается через `bpmn-auto-layout`
  (агенту не нужно вычислять координаты вручную).
- **`bpmnlint`** (bpmn-moddle + правила: `end-event-required`, `label-required`,
  `no-disconnected` и др.) возвращает неблокирующие замечания в `validation.lint`.
- В UI блок отображается через `bpmn-js NavigatedViewer` (пан/зум, кнопки масштаба);
  подтверждение отображения (`rendered_revision`) работает как для Mermaid.
- Экспорт: fenced-блок ```bpmn в `.md`; импорт распознаёт его обратно.

### draw.io

`write_diagram` с `format: "drawio"` создаёт блок типа `drawio`. В `source` передаётся
исходный XML с корнем `mxfile` или `mxGraphModel`. Поддерживаются сжатые и несжатые
страницы `diagram`; LiveNote сохраняет исходный XML без нормализации.

Экспорт страницы в Markdown использует fenced-блок ```drawio, импорт `.md` распознаёт
его обратно. Из карточки блока можно скачать исходник в формате `.drawio`.

### Общие свойства контракта

- **Защита от перезаписи** — все изменения страницы принимают `expected_revision`;
  при несовпадении возвращается конфликт с текущей ревизией, агент перечитывает страницу.
- **Идемпотентность** — повторный вызов с тем же `request_id` не создаёт дубликатов.
- **Честная валидация** — `write_diagram` при синтаксической ошибке НЕ публикует новую версию
  и возвращает позицию/текст ошибки; «не проверено» возвращается как `not_checked`, а не `ok`.
- **Рекомендуемый ритм** — сложные схемы публикуйте инкрементально: сначала минимальный
  корректный вариант, затем последовательные содержательные дополнения (пользователь видит
  каждый шаг в браузере).

## Веб-интерфейс

- Полноэкранное открытие диаграммы включает просмотр. Для `flowchart`, `graph` и `classDiagram`
  кнопка «Редактировать» открывает панель визуального редактора. Выберите узел или линию
  на схеме либо в списке, измените подпись, добавьте или удалите элементы.
  Mermaid рассчитывает расположение автоматически; перетаскивание перемещает холст.
  «Сохранить» записывает Mermaid-исходник с проверкой ревизии. «Отмена» возвращает
  исходную схему; при наличии изменений интерфейс запрашивает подтверждение.
  Для `classDiagram` панель позволяет менять подписи классов, поля и методы,
  добавлять и удалять классы и отношения, выбирать тип отношения.
  Поля и методы вводят по одному на строку. При изменении отношения его
  кардинальности сохраняются.
  Другие типы Mermaid и неподдерживаемые конструкции блок-схем доступны для просмотра
  и редактирования исходника в карточке блока. Стили и комментарии вне изменённых
  элементов сохраняются. При конфликте ревизии редактор оставляет черновик открытым
  и показывает исходник для копирования.
- Блоки `drawio` редактируются визуально в локальном редакторе draw.io. Preview показывает
  SVG первой страницы, поддерживает масштабирование и сброс масштаба, а также скачивание
  SVG и `.drawio`. PNG первой страницы доступен через REST
  `GET /pages/:pageId/blocks/:blockId/png`. Редактор сохраняет все страницы схемы.
- Вкладки открытых страниц, список страниц слева.
- Блоки: Markdown (react-markdown, без сырого HTML), Mermaid (`securityLevel: 'strict'`),
  BPMN и draw.io.
- Живое обновление по SSE (`/events`): страница подтягивается после событий агента;
  режим «Следовать за изменениями» можно выключить.
- При ошибке рендера новой версии остаётся предыдущий SVG с предупреждением;
  UI сообщает серверу фактически отображённую ревизию (`rendered_revision`).
- Импорт `.md` (fenced-блоки `mermaid`, `bpmn` и `drawio` становятся отдельными блоками)
  и экспорт страницы/всего блокнота в Markdown с исходниками диаграмм (схемы остаются
  редактируемыми).

## Модель данных

```
Workspace
  └── Page (id, title, revision)
        └── blocks[]: Markdown | Mermaid | BPMN | draw.io (id, source, position)
```

В vault ID страницы равен пути; ID блока — временный span текущей ревизии.
Vault хранит рабочее состояние в обычных Markdown и исходниках схем.
SQLite (WAL) доступен явно через `--db` и сохраняет стабильные ID.
Подтверждение рендера не меняет ревизию. Legacy экспорт/импорт с ограждениями
```mermaid, ```bpmn и ```drawio относится к SQLite; native vault сохраняет source целиком.

## Безопасность

- Сервер слушает только `127.0.0.1`, проверяет `Host` и `Origin` (защита от DNS rebinding).
- Bearer-токен (`LIVENOTE_TOKEN`) — опционально, для `/mcp`, `/api`, `/events`.
- Mermaid в режиме `strict` (без кликабельных действий, HTML в тексте кодируется);
  Markdown рендерится без исполнения HTML; внешние сетевые ресурсы UI не загружает.
  Редактор draw.io работает в локальном iframe и подключается только к собственному origin.
- Содержимое от агента считается недоверенным: оно отображается, но не исполняется.

## Разработка

```bash
npm run dev:server   # сервер с tsx watch (порт 4317)
npm run dev:web      # Vite dev-сервер UI (порт 5173, прокси на 4317)
npm run build        # tsc + vite build → dist/
npm run typecheck
```

## Архитектура кода

```
src/
  shared/types.ts        — контракт: модель данных, события SSE, DTO (общий для UI и сервера)
  server/
    index.ts             — CLI-точка входа (args, listen, --open)
    app.ts               — сборка Express: security-мидлвари, роутинг, статика, error-handler
    db.ts                — SQLite-хранилище: транзакции, ревизии, идемпотентность
    services.ts          — ядро: операции над страницами/блоками + события
    rest.ts / sse.ts     — REST API и канал живых обновлений
    export.ts / import.ts— Markdown-экспорт и импорт
    mcp/                 — MCP на Streamable HTTP (/mcp) + 8 инструментов
    validator/           — проверка Mermaid, BPMN и draw.io
  web/                   — React-приложение (Vite)
```
