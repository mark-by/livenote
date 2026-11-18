import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openVaultTab, removeVaultTabs } from '../src/web/vault/vaultTabState.ts';
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
