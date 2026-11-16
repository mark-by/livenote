/**
 * Просмотр страницы: заголовок (с inline-переименованием), блоки в порядке position,
 * панель действий каждого блока, добавление новых блоков в конец.
 * Все мутации идут через REST API с expectedRevision и подтверждаются перечитыванием
 * страницы (onMutated) — контракт revision-protection.
 */
import { useEffect, useState } from 'react';
import type { Block, BlockType, PageFull } from '../../shared/types';
import { createBlock, deleteBlock, updateBlock, updatePage } from '../api';
import { ApiError } from '../api';
import { BlockActions } from './BlockActions';
import { BpmnBlockView } from './BpmnBlockView';
import { useConfirm } from './ConfirmDialog';
import { DiagramFullscreen } from './DiagramFullscreen';
import { DrawioBlockView, EMPTY_DRAWIO_XML } from './DrawioBlockView';
import { DrawioFullscreen } from './DrawioFullscreen';
import { MarkdownBlockView } from './MarkdownBlockView';
import { MermaidBlockView } from './MermaidBlockView';

/** Указание прокрутить страницу к блоку (следовать за изменениями агента). */
export interface FocusBlock {
  pageId: string;
  blockId: string;
  /** Увеличивается при каждом новом фокусе — один и тот же блок может меняться несколько раз подряд. */
  nonce: number;
}

interface PageViewProps {
  page: PageFull;
  /** Перечитать страницу после успешной мутации (App обновит state). */
  onMutated(): void;
  /** Показать глобальное уведомление об ошибке. */
  onError(message: string): void;
  /** Не null — прокрутить к блоку и подсветить его. */
  focusBlock?: FocusBlock | null;
}

interface EditorState {
  blockId: string;
  source: string;
}

interface DraftState {
  type: BlockType;
  source: string;
}

/** Вытащить текст ошибки mermaid-валидации из WriteBlockResult[].validation. */
function validationErrorText(result: { validation?: { error?: { message?: string; line?: number } } }): string | null {
  const err = result.validation?.error;
  if (!err?.message) {
    return null;
  }
  return err.line !== undefined ? `${err.message} (строка ${err.line})` : err.message;
}

/** Тип ед�иной ошибки сохранения. */
type SaveError = string | null;

export function PageView({ page, onMutated, onError, focusBlock = null }: PageViewProps): React.JSX.Element {
  // Переименование заголовка
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // Редактирование существующего блока
  const [editor, setEditor] = useState<EditorState | null>(null);
  // Новый (ещё не созданный) блок в конце страницы
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  // Ошибка текущего редактора/черновика
  const [saveError, setSaveError] = useState<SaveError>(null);
  // Блок, открытый в полноэкранном просмотре диаграммы (null — модалка закрыта).
  const [fullscreenBlock, setFullscreenBlock] = useState<{ block: Block; revision: number } | null>(null);
  // Модальные подтверждения (удаление блока — вместо window.confirm).
  const { confirm, dialog: confirmDialog } = useConfirm();

  const reportApiError = (error: unknown): void => {
    if (error instanceof ApiError && error.code === 'conflict') {
      onError(`Страница изменилась на сервере (конфликт ревизии). Показываю актуальную версию.`);
      onMutated();
      return;
    }
    onError(error instanceof Error ? error.message : String(error));
  };

  // --- Переименование --------------------------------------------------------

  const startRename = (): void => {
    setTitleDraft(page.title);
    setEditingTitle(true);
  };

  const saveTitle = (): void => {
    if (!editingTitle) {
      return;
    }
    const clean = titleDraft.trim();
    setEditingTitle(false);
    if (clean.length === 0 || clean === page.title) {
      return;
    }
    updatePage(page.id, { title: clean }, page.revision)
      .then(() => onMutated())
      .catch((error: unknown) => reportApiError(error));
  };

  // --- Редактирование блока ---------------------------------------------------

  const startEdit = (block: Block): void => {
    if (block.type === 'drawio') {
      setFullscreenBlock({ block, revision: page.revision });
      return;
    }
    setSaveError(null);
    setEditor({ blockId: block.id, source: block.source });
  };

  const cancelEdit = (): void => {
    setEditor(null);
    setSaveError(null);
  };

  const saveEdit = (): void => {
    if (!editor) {
      return;
    }
    const source = editor.source;
    if (source.trim().length === 0) {
      setSaveError('Содержимое блока не может быть пустым');
      return;
    }
    updateBlock(page.id, editor.blockId, { source, expectedRevision: page.revision })
      .then((result) => {
        const validationError = validationErrorText(result);
        if (validationError !== null) {
          setSaveError(validationError);
          return;
        }
        setEditor(null);
        setSaveError(null);
        onMutated();
      })
      .catch((error: unknown) => reportApiError(error));
  };

  // --- Добавление / сохранение нового блока ------------------------------------

  const chooseAddType = (type: BlockType): void => {
    setShowAddMenu(false);
    setSaveError(null);
    if (type === 'drawio') {
      createBlock(page.id, {
        type,
        source: EMPTY_DRAWIO_XML,
        expectedRevision: page.revision
      }).then(() => onMutated()).catch((error: unknown) => reportApiError(error));
      return;
    }
    setDraft({ type, source: '' });
  };

  const cancelDraft = (): void => {
    setDraft(null);
    setSaveError(null);
  };

  const saveDraft = (): void => {
    if (!draft) {
      return;
    }
    const source = draft.source;
    if (source.trim().length === 0) {
      setSaveError('Содержимое блока не может быть пустым');
      return;
    }
    createBlock(page.id, { type: draft.type, source, expectedRevision: page.revision })
      .then((result) => {
        const validationError = validationErrorText(result);
        if (validationError !== null) {
          setSaveError(validationError);
          return;
        }
        setDraft(null);
        setSaveError(null);
        onMutated();
      })
      .catch((error: unknown) => reportApiError(error));
  };

  // --- Перемещение / удаление --------------------------------------------------

  const moveBlock = (block: Block, direction: -1 | 1): void => {
    const index = page.blocks.findIndex((candidate) => candidate.id === block.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= page.blocks.length) {
      return;
    }
    const reordered = [...page.blocks];
    [reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!];
    const blockOrder = reordered.map((candidate) => candidate.id);
    updatePage(page.id, { blockOrder }, page.revision)
      .then(() => onMutated())
      .catch((error: unknown) => reportApiError(error));
  };

  // «Следовать за изменениями»: прокрутить к блоку агента и подсветить его.
  // Блок может появиться позже (вкладка открыта, данные ещё грузятся) — ретраи до ~2 секунд.
  useEffect(() => {
    if (focusBlock === null) {
      return;
    }
    const selector = `.block[data-block-id="${CSS.escape(focusBlock.blockId)}"]`;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const element = document.querySelector(selector);
      if (element !== null) {
        window.clearInterval(timer);
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.add('block--flash');
        window.setTimeout(() => element.classList.remove('block--flash'), 1600);
        return;
      }
      if (attempts >= 13) {
        window.clearInterval(timer);
      }
    }, 150);
    return () => window.clearInterval(timer);
  }, [focusBlock?.nonce, focusBlock?.blockId]);

  const removeBlock = (block: Block): void => {
    void confirm({
      title: 'Удалить блок',
      message: `Удалить блок «${block.id}» со страницы «${page.title}»?`,
      confirmLabel: 'Удалить',
      danger: true
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }
        return deleteBlock(page.id, block.id, page.revision)
          .then(() => onMutated())
          .catch((error: unknown) => reportApiError(error));
      })
      .catch((error: unknown) => reportApiError(error));
  };

  // --- Разметка ----------------------------------------------------------------

  const blocks = page.blocks;
  const lastPosition = blocks.length > 0 ? blocks[blocks.length - 1]!.position : -1;

  return (
    <>
    <div className="page">
      <header className="page__header">
        <div className="page__header-main">
        {editingTitle ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveTitle();
            }}
          >
            <input
              className="page__title-input"
              value={titleDraft}
              autoFocus
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => saveTitle()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setEditingTitle(false);
                }
              }}
            />
          </form>
        ) : (
          <button type="button" className="page__title page__title--editable" onClick={startRename} title="Переименовать">
            {page.title}
          </button>
        )}
        <div className="page__revision">Ревизия {page.revision}</div>
        </div>
      </header>

      <div className="page__blocks">
        {blocks.map((block) => {
          const isEditing = editor?.blockId === block.id;
          const position = block.position;
          const canMoveUp = position > 0;
          const canMoveDown = position < blocks.length - 1;

          return (
            <section key={block.id} className="block" data-block-id={block.id}>
              {isEditing ? (
                <div className="block-editor">
                  {renderEditorTextarea(block, editor!.source, (source) => setEditor({ ...editor!, source }))}
                  <div className="block-editor__bar">
                    <button className="btn btn--primary" type="button" onClick={saveEdit}>
                      Сохранить
                    </button>
                    <button className="btn" type="button" onClick={cancelEdit}>
                      Отмена
                    </button>
                    {renderHint(block.type)}
                  </div>
                  {saveError !== null && <div className="block-editor__error">{saveError}</div>}
                </div>
              ) : (
                <>
                  <BlockActions
                    canMoveUp={canMoveUp}
                    canMoveDown={canMoveDown}
                    copyText={block.source}
                    onEdit={() => startEdit(block)}
                    onMoveUp={() => moveBlock(block, -1)}
                    onMoveDown={() => moveBlock(block, 1)}
                    onDelete={() => removeBlock(block)}
                  />
                  {block.type === 'mermaid' ? (
                    <MermaidBlockView
                      block={block}
                      pageRevision={page.revision}
                      onExpand={() => setFullscreenBlock({ block, revision: page.revision })}
                    />
                  ) : block.type === 'bpmn' ? (
                    <BpmnBlockView
                      block={block}
                      pageRevision={page.revision}
                      onExpand={() => setFullscreenBlock({ block, revision: page.revision })}
                    />
                  ) : block.type === 'drawio' ? (
                    <DrawioBlockView
                      block={block}
                      pageRevision={page.revision}
                      pageTitle={page.title}
                      onExpand={() => setFullscreenBlock({ block, revision: page.revision })}
                    />
                  ) : (
                    <MarkdownBlockView source={block.source} />
                  )}
                </>
              )}
            </section>
          );
        })}

        {draft !== null ? (
          <section className="block block--draft">
            <div className="block-editor">
              {renderEditorTextarea(
                { id: 'draft', type: draft.type, pageId: page.id, position: lastPosition + 1 },
                draft.source,
                (source) => setDraft({ ...draft, source })
              )}
              <div className="block-editor__bar">
                <button className="btn btn--primary" type="button" onClick={saveDraft}>
                  Создать
                </button>
                <button className="btn" type="button" onClick={cancelDraft}>
                  Отмена
                </button>
                {renderHint(draft.type)}
              </div>
              {saveError !== null && <div className="block-editor__error">{saveError}</div>}
            </div>
          </section>
        ) : (
          <div className="block__add">
            {showAddMenu ? (
              <div className="block__add-menu">
                <button className="btn" type="button" onClick={() => chooseAddType('markdown')}>
                  Markdown
                </button>
                <button className="btn" type="button" onClick={() => chooseAddType('mermaid')}>
                  Mermaid
                </button>
                <button className="btn" type="button" onClick={() => chooseAddType('bpmn')}>
                  BPMN
                </button>
                <button className="btn" type="button" onClick={() => chooseAddType('drawio')}>
                  draw.io
                </button>
                <button className="btn" type="button" onClick={() => setShowAddMenu(false)}>
                  Отмена
                </button>
              </div>
            ) : (
              <button className="btn btn--add-block" type="button" onClick={() => setShowAddMenu(true)}>
                + Добавить блок
              </button>
            )}
          </div>
        )}
      </div>
    </div>

    {fullscreenBlock !== null && fullscreenBlock.block.type === 'drawio' ? (
      <DrawioFullscreen
        block={fullscreenBlock.block}
        pageTitle={page.title}
        pageRevision={fullscreenBlock.revision}
        onSaved={(source, revision) => {
          setFullscreenBlock({ block: { ...fullscreenBlock.block, source }, revision });
          onMutated();
        }}
        onClose={() => setFullscreenBlock(null)}
      />
    ) : fullscreenBlock !== null ? (
      <DiagramFullscreen
        block={fullscreenBlock.block}
        pageTitle={page.title}
        pageRevision={fullscreenBlock.revision}
        onSaved={(source, revision) => {
          setFullscreenBlock({ block: { ...fullscreenBlock.block, source }, revision });
          onMutated();
        }}
        onClose={() => setFullscreenBlock(null)}
      />
    ) : null}
    {confirmDialog}
    </>
  );
}

/** Общий textarea редактора для существующего и нового блока. */
function renderEditorTextarea(
  block: { id: string; type: BlockType; pageId: string; position: number },
  value: string,
  onChange: (value: string) => void
): React.JSX.Element {
  return (
    <textarea
      className="block-editor__textarea"
      value={value}
      spellCheck={false}
      autoFocus
      placeholder={
        block.type === 'mermaid'
          ? 'Пример: graph TD\n  A --> B'
          : block.type === 'bpmn'
            ? 'Вставьте XML-код BPMN-схемы…'
            : block.type === 'drawio'
              ? 'Вставьте XML-код draw.io…'
              : 'Введите Markdown…'
      }
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Подсказка о правилах рендера под строкой действий. */
function renderHint(type: BlockType): React.JSX.Element {
  return (
    <span className="block-editor__hint">
      {type === 'mermaid'
        ? 'Синтаксис проверится до сохранения'
        : type === 'bpmn'
          ? 'BPMN 2.0 XML, просмотр только для чтения'
          : type === 'drawio'
            ? 'Схема открывается в локальном визуальном редакторе'
            : 'Markdown без исполнения HTML'}
    </span>
  );
}
