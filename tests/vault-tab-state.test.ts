import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remapPath } from '../src/web/vault/vaultPaths.ts';
import { vaultPanes } from '../src/web/vault/vaultPaneState.ts';
import { closeVaultPane, focusVaultPane, openVaultTab, remapVaultTabPaths, removeVaultTabs, splitVaultTab } from '../src/web/vault/vaultTabState.ts';
import type { VaultTabState } from '../src/web/vault/vaultTabState.ts';

const first = 'Проект/Первый.md';
const preview = 'Проект/Предпросмотр.md';
const next = 'Проект/Следующий.md';
const last = 'Проект/Последний.md';

test('новый файл занимает место вкладки предпросмотра', () => {
  // Arrange: вкладка предпросмотра находится между закреплёнными вкладками.
  const state: VaultTabState = { openTabs: [first, preview, last], activeId: last, previewId: preview };

  // Act: открываем новый файл.
  const result = openVaultTab(state, next, true);

  // Assert: соседние вкладки сохраняют порядок.
  assert.deepEqual(result, { openTabs: [first, next, last], activeId: next, previewId: next });
});

test('новый файл сохраняет защищённую вкладку предпросмотра', () => {
  // Arrange: текущую вкладку предпросмотра нельзя заменить.
  const state: VaultTabState = { openTabs: [first, preview], activeId: preview, previewId: preview };

  // Act: открываем новый файл.
  const result = openVaultTab(state, next, false);

  // Assert: новая вкладка становится единственной вкладкой предпросмотра.
  assert.deepEqual(result, { openTabs: [first, preview, next], activeId: next, previewId: next });
});

test('переход на открытую вкладку сохраняет вкладку предпросмотра', () => {
  // Arrange: первая вкладка уже открыта, активна вкладка предпросмотра.
  const state: VaultTabState = { openTabs: [first, preview], activeId: preview, previewId: preview };

  // Act: открываем первую вкладку.
  const result = openVaultTab(state, first, true);

  // Assert: меняется только активная вкладка.
  assert.deepEqual(result, { ...state, activeId: first });
});

test('групповое закрытие выбирает ближайшую оставшуюся вкладку справа', () => {
  // Arrange: справа от активной вкладки остаётся одна вкладка.
  const state: VaultTabState = { openTabs: [first, preview, next, last], activeId: preview, previewId: preview };

  // Act: закрываем активную вкладку и её соседнюю вкладку справа.
  const result = removeVaultTabs(state, new Set([next, preview]));

  // Assert: правый сосед становится активным, вкладка предпросмотра закрыта.
  assert.deepEqual(result, { openTabs: [first, last], activeId: last, previewId: null });
});

test('групповое закрытие выбирает ближайшую оставшуюся вкладку слева', () => {
  // Arrange: активная вкладка находится справа.
  const state: VaultTabState = { openTabs: [first, preview, next, last], activeId: last, previewId: preview };

  // Act: закрываем две правые вкладки.
  const result = removeVaultTabs(state, new Set([last, next]));

  // Assert: вкладка предпросмотра остаётся открытой и становится активной.
  assert.deepEqual(result, { openTabs: [first, preview], activeId: preview, previewId: preview });
});

test('групповое закрытие оставляет активную вкладку на месте', () => {
  // Arrange: активная вкладка находится между двумя другими.
  const state: VaultTabState = { openTabs: [first, preview, next], activeId: preview, previewId: preview };

  // Act: закрываем вкладки слева и справа.
  const result = removeVaultTabs(state, new Set([first, next]));

  // Assert: активная вкладка сохраняет статус предпросмотра.
  assert.deepEqual(result, { openTabs: [preview], activeId: preview, previewId: preview });
});

test('после закрытия всех вкладок активная вкладка отсутствует', () => {
  // Arrange: открыты закреплённая вкладка и вкладка предпросмотра.
  const state: VaultTabState = { openTabs: [first, preview], activeId: first, previewId: preview };

  // Act: закрываем обе вкладки.
  const result = removeVaultTabs(state, new Set([first, preview]));

  // Assert: список вкладок и ссылки на вкладки очищены.
  assert.deepEqual(result, { openTabs: [], activeId: null, previewId: null });
});

test('перенос папки обновляет пути во вложенных панелях', () => {
  // Arrange: три файла из одной папки открыты в трёх панелях.
  const unrelated = 'Проект-архив/Заметка.md';
  const tabs: VaultTabState = { openTabs: [first, next, last, unrelated], activeId: first, previewId: null };
  const horizontal = splitVaultTab(tabs, next, 'right');
  const nested = splitVaultTab(horizontal, last, 'down');
  const moved = [{ from: 'Проект', to: 'Архив/Проект' }];
  const remap = (path: string) => remapPath(path, moved);
  const movedFirst = 'Архив/Проект/Первый.md';
  const movedNext = 'Архив/Проект/Следующий.md';
  const movedLast = 'Архив/Проект/Последний.md';

  // Act: обновляем пути после переноса папки.
  const result = remapVaultTabPaths(nested, remap);

  // Assert: порядок вкладок, расположение панелей и фокус не меняются.
  assert.deepEqual(result, {
    openTabs: [movedFirst, movedNext, movedLast, unrelated],
    activeId: movedLast,
    previewId: null,
    layout: {
      focused: 2,
      root: {
        kind: 'split', id: 1, direction: 'right', percent: 50,
        first: { kind: 'pane', id: 0, path: movedFirst },
        second: {
          kind: 'split', id: 2, direction: 'down', percent: 50,
          first: { kind: 'pane', id: 1, path: movedNext },
          second: { kind: 'pane', id: 2, path: movedLast }
        }
      }
    }
  });
});

test('после переноса папки и закрытия активной панели соседняя панель отдаёт новый путь', () => {
  // Arrange: два файла из одной папки открыты в соседних панелях.
  const tabs: VaultTabState = { openTabs: [first, next], activeId: first, previewId: null };
  const split = splitVaultTab(tabs, next, 'right');
  const moved = [{ from: 'Проект', to: 'Архив/Проект' }];
  const remap = (path: string) => remapPath(path, moved);
  const relocated = remapVaultTabPaths(split, remap);
  const rightPaneId = 1;

  // Act: закрываем активную правую панель.
  const result = closeVaultPane(relocated, rightPaneId);

  // Assert: активный путь берётся из левой панели после переноса.
  assert.equal(result.activeId, 'Архив/Проект/Первый.md');
});

test('новый файл заменяет скрытый предпросмотр после переноса', () => {
  // Arrange: вкладка предпросмотра открыта, но активна закреплённая вкладка.
  const tabs: VaultTabState = { openTabs: [first, preview, last], activeId: last, previewId: preview };
  const moved = [{ from: preview, to: 'Архив/Предпросмотр.md' }];
  const remap = (path: string) => remapPath(path, moved);
  const relocated = remapVaultTabPaths(tabs, remap);

  // Act: открываем новый файл с разрешением заменить предпросмотр.
  const result = openVaultTab(relocated, next, true);

  // Assert: новый файл занимает прежнее место вкладки предпросмотра.
  assert.deepEqual(result, { openTabs: [first, next, last], activeId: next, previewId: next });
});

for (const { name, focused, expectedTabs, expectedPanes } of [
  { name: 'сохраняет предпросмотр слева при открытии файла справа', focused: 1,
    expectedTabs: [first, preview, next], expectedPanes: [preview, next] },
  { name: 'заменяет предпросмотр в выбранной панели', focused: 0,
    expectedTabs: [first, next], expectedPanes: [next, first] }
]) {
  test(`workspace A4: ${name}`, () => {
    // Arrange: закреплённая вкладка справа, предпросмотр слева.
    const initial: VaultTabState = { openTabs: [first], activeId: first, previewId: null };
    const split = splitVaultTab(initial, first, 'right');
    const withPreviewOnLeft = openVaultTab(focusVaultPane(split, 0), preview, true);
    const state = focusVaultPane(openVaultTab(focusVaultPane(withPreviewOnLeft, 1), first, true), focused);

    // Act: открываем третий файл с разрешением заменить предпросмотр.
    const result = openVaultTab(state, next, true);

    // Assert: замена не затрагивает соседнюю панель.
    assert.deepEqual(result.openTabs, expectedTabs);
    assert.equal(result.activeId, next);
    assert.equal(result.previewId, next);
    assert.ok(result.layout);
    assert.deepEqual(vaultPanes(result.layout.root).map((pane) => pane.path), expectedPanes);
  });
}

test('workspace A4: закрытие неактивной вкладки сохраняет выбор среди нескольких соседей', () => {
  // Arrange: справа от активной вкладки остаётся кандидат для ошибочного переключения.
  const state: VaultTabState = { openTabs: [first, preview, next, last], activeId: preview, previewId: preview };

  // Act: закрываем вкладку справа, не трогая активную.
  const result = removeVaultTabs(state, new Set([next]));

  // Assert: остаются три вкладки, выбор и предпросмотр не меняются.
  assert.deepEqual(result, { openTabs: [first, preview, last], activeId: preview, previewId: preview });
});
