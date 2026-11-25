/**
 * Корневой компонент LiveNote: вкладки, sidebar, live-обновления по SSE,
 * toolbar (новая страница, импорт, экспорт, шестерёнка настроек),
 * диалог ввода токена, диалог настроек.
 */
import { Alert, Button, CloseButton, Spinner, Tabs } from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiConfig, LiveEvent, PageFull, PageSummary } from '../shared/types';
import {
  ApiError,
  clearToken,
  createPage,
  deletePage,
  exportAll,
  exportPage,
  getConfig,
  getPage,
  getToken,
  importMarkdown,
  listPages,
  setToken,
  UNAUTHORIZED_EVENT
} from './api';
import { connectEvents } from './events';
import { useConfirm } from './components/ConfirmDialog';
import { PageView } from './components/PageView';
import { SettingsDialog } from './components/SettingsDialog';
import type { PageWidth } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { TokenDialog } from './components/TokenDialog';
import { useShortcuts } from './useShortcuts';

const STORAGE_TABS = 'livenote_open_tabs';
const STORAGE_ACTIVE = 'livenote_active_tab';
const STORAGE_FOLLOW = 'livenote_follow';
const STORAGE_SIDEBAR = 'livenote_sidebar_open';
const STORAGE_PAGE_WIDTH = 'livenote_page_width';

/** Прочитать настройку ширины из localStorage с валидацией. */
function loadPageWidth(): PageWidth {
  const raw = localStorage.getItem(STORAGE_PAGE_WIDTH);
  return raw === 'wide' || raw === 'full' ? raw : 'standard';
}

/** Задержка (мс) перед перечитыванием страницы после пачки событий. */
const REFRESH_DEBOUNCE_MS = 150;

/** Прочитать JSON-список вкладок из localStorage. */
function loadStoredTabs(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_TABS);
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function LegacyApp(): React.JSX.Element {
  // Настройки и готовность после начальной загрузки
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [ready, setReady] = useState(false);

  // Данные
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [openTabs, setOpenTabs] = useState<string[]>(() => loadStoredTabs());
  const [activeTab, setActiveTab] = useState<string | null>(() => localStorage.getItem(STORAGE_ACTIVE));
  // Кэш полных страниц открытых вкладок
  const [pagesById, setPagesById] = useState<Record<string, PageFull>>({});
  const [followEvents, setFollowEvents] = useState<boolean>(
    () => localStorage.getItem(STORAGE_FOLLOW) !== '0'
  );
  // Ширина страницы: стандартная / широкая / на всю (сохраняется в localStorage).
  const [pageWidth, setPageWidth] = useState<PageWidth>(() => loadPageWidth());
  // Сайдбар «Страницы»: скрывается/показывается иконкой в toolbar (сохраняется).
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => localStorage.getItem(STORAGE_SIDEBAR) !== '0');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  useShortcuts({ openSettings });
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Модальные подтверждения (замена window.confirm): см. handleDeletePage.
  const { confirm, dialog: confirmDialog } = useConfirm();

  // Ref'ы, чтобы обработчики SSE видели актуальное состояние без переподписки
  const fileRef = useRef<HTMLInputElement>(null);
  const followRef = useRef(followEvents);
  const openTabsRef = useRef(openTabs);
  const pagesByIdRef = useRef(pagesById);
  const activeTabRef = useRef(activeTab);
  // Таймеры debounce по страницам
  const debounceTimers = useRef(new Map<string, number>());
  // Счётчик фокусов следования: nonce в focusTarget заставляет PageView
  // отреагировать даже на повторное изменение того же блока.
  const focusNonceRef = useRef(0);
  const [focusTarget, setFocusTarget] = useState<{ pageId: string; blockId: string; nonce: number } | null>(null);

  useEffect(() => {
    followRef.current = followEvents;
    if (followEvents) {
      localStorage.setItem(STORAGE_FOLLOW, '1');
    } else {
      localStorage.setItem(STORAGE_FOLLOW, '0');
    }
  }, [followEvents]);

  // Ширина страницы сохраняется, чтобы переживать перезагрузку.
  useEffect(() => {
    localStorage.setItem(STORAGE_PAGE_WIDTH, pageWidth);
  }, [pageWidth]);

  // Видимость сайдбара сохраняется, чтобы переживать перезагрузку.
  useEffect(() => {
    localStorage.setItem(STORAGE_SIDEBAR, sidebarOpen ? '1' : '0');
  }, [sidebarOpen]);

  useEffect(() => {
    openTabsRef.current = openTabs;
    localStorage.setItem(STORAGE_TABS, JSON.stringify(openTabs));
  }, [openTabs]);

  useEffect(() => {
    activeTabRef.current = activeTab;
    if (activeTab !== null) {
      localStorage.setItem(STORAGE_ACTIVE, activeTab);
    }
  }, [activeTab]);

  useEffect(() => {
    pagesByIdRef.current = pagesById;
  }, [pagesById]);

  const showError = (message: string): void => {
    setGlobalError(message);
  };

  // --- Загрузка данных ---------------------------------------------------------

  const refreshSidebar = async (): Promise<void> => {
    try {
      setPages(await listPages());
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
  };

  const refreshPage = async (pageId: string): Promise<void> => {
    try {
      const page = await getPage(pageId);
      setPagesById((prev) => ({ ...prev, [pageId]: page }));
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
  };

  const refreshOpenPages = async (): Promise<void> => {
    await Promise.all(openTabsRef.current.map((pageId) => refreshPage(pageId)));
  };

  const bootstrap = async (): Promise<void> => {
    await Promise.all([refreshSidebar(), refreshOpenPages()]);
    setReady(true);
  };

  // --- Вкладки -------------------------------------------------------------------

  const openPage = (pageId: string): void => {
    setOpenTabs((prev) => (prev.includes(pageId) ? prev : [...prev, pageId]));
    setActiveTab(pageId);
    // Заранее подтягиваем содержимое страницы, если ещё нет в кэше
    void refreshPage(pageId);
    void refreshSidebar();
  };

  const closeTab = (pageId: string): void => {
    setOpenTabs((prev) => {
      const next = prev.filter((id) => id !== pageId);
      if (activeTabRef.current === pageId) {
        const nextActive = next.length > 0 ? next[next.length - 1]! : null;
        setActiveTab(nextActive);
        if (nextActive !== null) {
          window.requestAnimationFrame(() => {
            document.querySelector<HTMLElement>(`[data-legacy-tab="${CSS.escape(nextActive)}"]`)?.focus();
          });
        }
      }
      return next;
    });
    setPagesById((prev) => {
      const copy = { ...prev };
      delete copy[pageId];
      return copy;
    });
  };

  // --- Обработчики SSE --------------------------------------------------------------

  // Обновить страницу после события, если оно не устарело: защита от гонок/старых событий.
  const refreshPageFromEvent = (pageId: string, eventRevision: number): void => {
    void getPage(pageId)
      .then((fresh) => {
        const current = pagesByIdRef.current[pageId];
        if (current !== undefined && fresh.revision < current.revision) {
          return; // пришло более старое состояние — игнорируем
        }
        // Отдельная проверка: событие актуальнее состояния
        if (eventRevision < (current?.revision ?? 0)) {
          return;
        }
        // Контент открытой вкладки обновляется всегда; тоггл управляет только перебросом.
        setPagesById((prev) => ({ ...prev, [pageId]: fresh }));
      })
      .catch((error: unknown) => {
        showError(error instanceof Error ? error.message : String(error));
      });
  };

  const schedulePageRefresh = (pageId: string, eventRevision: number): void => {
    // Обновление контента открытых вкладок — всегда, независимо от «Следовать»:
    // тоггл управляет только перебросом на вкладку/скроллом к блоку.
    if (!openTabsRef.current.includes(pageId)) {
      return; // страница не открыта — содержимое не подтягиваем
    }
    const existing = debounceTimers.current.get(pageId);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      debounceTimers.current.delete(pageId);
      refreshPageFromEvent(pageId, eventRevision);
    }, REFRESH_DEBOUNCE_MS);
    debounceTimers.current.set(pageId, timer);
  };

  // Подключение к /events после успешной авторизации
  useEffect(() => {
    if (!ready) {
      return;
    }

    // «Следовать за изменениями»: открыть/активировать вкладку страницы агента
    // и подсветить изменённый блок. nonce гарантирует срабатывание при повторных
    // изменениях того же блока.
    const followToBlock = (pageId: string, blockId: string): void => {
      if (!openTabsRef.current.includes(pageId)) {
        openPage(pageId);
      } else if (activeTabRef.current !== pageId) {
        setActiveTab(pageId);
      }
      focusNonceRef.current += 1;
      setFocusTarget({ pageId, blockId, nonce: focusNonceRef.current });
    };

    const connection = connectEvents({
      onPageCreated: (event: LiveEvent) => {
        void refreshSidebar();
        // Новая страница агента при включённом следовании открывается вкладкой.
        if (followRef.current) {
          openPage(event.pageId);
        }
        if (event.pageId === activeTabRef.current) {
          schedulePageRefresh(event.pageId, event.revision);
        }
      },
      onPageDeleted: (event: LiveEvent) => {
        closeTab(event.pageId);
        void refreshSidebar();
      },
      onPageUpdated: (event: LiveEvent) => {
        schedulePageRefresh(event.pageId, event.revision);
        void refreshSidebar();
      },
      onBlockCreated: (event: LiveEvent) => {
        if (followRef.current && event.blockId !== undefined) {
          followToBlock(event.pageId, event.blockId);
        }
        schedulePageRefresh(event.pageId, event.revision);
      },
      onBlockUpdated: (event: LiveEvent) => {
        if (followRef.current && event.blockId !== undefined) {
          followToBlock(event.pageId, event.blockId);
        }
        schedulePageRefresh(event.pageId, event.revision);
      },
      onBlockDeleted: (event: LiveEvent) => schedulePageRefresh(event.pageId, event.revision),
      // Переподключение: перечитываем список и все открытые страницы
      onOpen: () => {
        void refreshSidebar();
        void refreshOpenPages();
      }
    });
    return () => {
      connection.close();
      for (const timer of debounceTimers.current.values()) {
        window.clearTimeout(timer);
      }
      debounceTimers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // --- Авторизация ----------------------------------------------------------------

  // Сервер отверг токен — показываем диалог ввода заново
  useEffect(() => {
    const onUnauthorized = (): void => {
      clearToken();
      setTokenDialogOpen(true);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  // Начальная загрузка: конфиг → токен или сразу данные
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await getConfig();
        if (cancelled) {
          return;
        }
        setConfig(cfg);
        if (cfg.tokenRequired && getToken() === null) {
          setTokenDialogOpen(true);
          setReady(true);
          return;
        }
        await bootstrap();
      } catch (error) {
        if (!cancelled) {
          showError(error instanceof Error ? error.message : String(error));
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTokenConfirm = (token: string): void => {
    setToken(token);
    setTokenDialogOpen(false);
    void bootstrap();
  };

  // --- Toolbar-действия --------------------------------------------------------------

  const handleCreatePage = (): void => {
    void createPage('Без названия')
      .then((page) => {
        openPage(page.id);
      })
      .catch((error: unknown) => showError(error instanceof Error ? error.message : String(error)));
  };

  const handleImportFile = (file: File): void => {
    void file
      .text()
      .then((content) => importMarkdown({ content }))
      .then((page) => openPage(page.id))
      .catch((error: unknown) => showError(error instanceof Error ? error.message : String(error)));
  };

  // Удаление страницы из sidebar: подтверждение → DELETE API → закрыть вкладку и обновить список.
  const handleDeletePage = (pageId: string): void => {
    const summary = pages.find((page) => page.id === pageId);
    if (summary === undefined) {
      return;
    }
    void confirm({
      title: 'Удалить страницу',
      message: `Страница «${summary.title}» и её содержимое будут удалены окончательно.`,
      confirmLabel: 'Удалить',
      danger: true
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }
        return deletePage(pageId, summary.revision)
          .then(() => {
            closeTab(pageId);
            void refreshSidebar();
          })
          .catch((error: unknown) => {
            if (error instanceof ApiError && error.code === 'conflict') {
              // Страница изменилась: подтягиваем актуальный список (новую ревизию) для повторной попытки.
              showError('Страница была изменена, обновите список и попробуйте снова');
              void refreshSidebar();
            } else {
              showError(error instanceof Error ? error.message : String(error));
            }
          });
      })
      .catch((error: unknown) => {
        showError(error instanceof Error ? error.message : String(error));
      });
  };

  const handleExportPage = (): void => {
    if (activeTab === null) {
      return;
    }
    void exportPage(activeTab).catch((error: unknown) =>
      showError(error instanceof Error ? error.message : String(error))
    );
  };

  const handleExportAll = (): void => {
    void exportAll().catch((error: unknown) =>
      showError(error instanceof Error ? error.message : String(error))
    );
  };

  const handleRefreshActive = (): void => {
    if (activeTab !== null) {
      void refreshPage(activeTab);
    }
    void refreshSidebar();
  };

  // Активная открытая страница для области просмотра
  const activePage: PageFull | undefined =
    activeTab !== null ? pagesById[activeTab] : undefined;

  return (
    <div className="app" data-page-width={pageWidth}>
      <div className="topbar">
        <div className="toolbar">
          <Button
            className="btn--icon"
            variant="ghost"
            onPress={() => setSidebarOpen(!sidebarOpen)}
            aria-label={sidebarOpen ? 'Скрыть страницы' : 'Показать страницы'}
            aria-pressed={sidebarOpen}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </Button>
          <span className="toolbar__title">LiveNote</span>
          <Button variant="primary" onPress={handleCreatePage}>
            + Новая страница
          </Button>
          <Button variant="secondary" onPress={() => fileRef.current?.click()}>
            Импорт .md
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            style={{ display: 'none' }}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                handleImportFile(file);
              }
              event.target.value = '';
            }}
          />
          <Button variant="secondary" onPress={handleExportPage} isDisabled={activeTab === null}>
            Экспорт страницы
          </Button>
          <Button variant="secondary" onPress={handleExportAll}>
            Экспорт всего
          </Button>
          <Button
            className="btn--icon"
            variant="ghost"
            onPress={openSettings}
            aria-label="Настройки"
            aria-haspopup="dialog"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1h1.82a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1 1z" />
            </svg>
          </Button>
        </div>

        {openTabs.length > 0 && (
          <Tabs
            aria-label="Открытые страницы"
            className="tabs-bar"
            selectedKey={activeTab ?? undefined}
            onSelectionChange={(key) => openPage(String(key))}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="Открытые страницы">
                {openTabs.map((pageId) => {
                  const tabPage = pagesById[pageId];
                  const sidebarMeta = pages.find((item) => item.id === pageId);
                  const title = tabPage?.title ?? sidebarMeta?.title ?? pageId;
                  return (
                    <Tabs.Tab id={pageId} key={pageId} className="tab" data-legacy-tab={pageId}>
                      <span className="tab__title">{title}</span>
                      <Tabs.Indicator />
                      <CloseButton
                        className="tab__close"
                        aria-label={`Закрыть ${title}`}
                        onPress={() => closeTab(pageId)}
                      />
                    </Tabs.Tab>
                  );
                })}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        )}
      </div>

      <div className="app-main">
        {sidebarOpen && (
          <Sidebar pages={pages} activePageId={activeTab} onOpenPage={openPage} onDeletePage={handleDeletePage} />
        )}
        <main className="app-content">
          {activePage !== undefined ? (
            <PageView
              page={activePage}
              onMutated={handleRefreshActive}
              onError={showError}
              focusBlock={focusTarget !== null && focusTarget.pageId === activePage.id ? focusTarget : null}
            />
          ) : (
            <div className="empty-state">
              {ready ? (
                <>
                  <p>Выберите страницу слева или создайте новую.</p>
                  <Button variant="primary" onPress={handleCreatePage}>
                    + Новая страница
                  </Button>
                </>
              ) : (
                <div role="status" className="legacy-loading">
                  <Spinner aria-label="Загрузка страниц" />
                  <span>Загрузка страниц…</span>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {config !== null && tokenDialogOpen && <TokenDialog onConfirm={handleTokenConfirm} />}
      {confirmDialog}
      {settingsOpen && (
        <SettingsDialog
          pageWidth={pageWidth}
          onPageWidthChange={setPageWidth}
          followEvents={followEvents}
          onFollowChange={setFollowEvents}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {globalError !== null && (
        <Alert className="global-error" color="danger" role="alert">
          <Alert.Content>
            <Alert.Title>Не удалось выполнить действие</Alert.Title>
            <Alert.Description>{globalError}</Alert.Description>
          </Alert.Content>
          <Button
            size="sm"
            variant="ghost"
            className="global-error__close"
            onPress={() => setGlobalError(null)}
            aria-label="Закрыть"
          >
            ×
          </Button>
        </Alert>
      )}
    </div>
  );
}
