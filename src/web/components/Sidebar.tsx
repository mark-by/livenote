/**
 * Левая панель: список страниц LiveNote.
 * Клик по строке открывает страницу во вкладке;
 * кнопка-корзина справа (видна при hover) удаляет страницу.
 */
import type { PageSummary } from '../../shared/types';

interface SidebarProps {
  pages: PageSummary[];
  activePageId: string | null;
  onOpenPage(pageId: string): void;
  /** Удаление страницы. Если не передан — корзина не показывается. */
  onDeletePage?(pageId: string): void;
}

/** Иконка корзины (lucide trash-2, stroke-стиль). */
function TrashIcon(): React.JSX.Element {
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
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

export function Sidebar({ pages, activePageId, onOpenPage, onDeletePage }: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar__header">Страницы</div>
      <div className="sidebar__list">
        {pages.length === 0 ? (
          <div className="sidebar__empty">Страниц пока нет</div>
        ) : (
          pages.map((page) => (
            <div
              key={page.id}
              className={`sidebar__item${page.id === activePageId ? ' sidebar__item--active' : ''}`}
            >
              <button
                type="button"
                className="sidebar__item__open"
                title={page.title}
                onClick={() => onOpenPage(page.id)}
              >
                <span className="sidebar__item__label">{page.title}</span>
              </button>
              {onDeletePage !== undefined && (
                <button
                  type="button"
                  className="sidebar__item__delete"
                  aria-label="Удалить страницу"
                  title="Удалить страницу"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeletePage(page.id);
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
