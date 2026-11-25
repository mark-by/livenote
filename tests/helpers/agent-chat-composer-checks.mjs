import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expect } from 'playwright/test';

export function registerComposerChecks(getFixture, timeout) {
  test('Шкала контекста в поле отправки обновляется и не переносит данные между разговорами', { timeout }, async t => {
    // Arrange: первый ответ приходит без оценки. Следующий запрос получает две оценки.
    const fixture = getFixture();
    const { page, panel } = await fixture.open(t);
    const composer = panel.locator('form').filter({ has: page.getByRole('textbox', { name: 'Сообщение агенту' }) });
    const textbox = composer.getByRole('textbox', { name: 'Сообщение агенту' });
    const gauge = composer.getByTestId('agent-context-progress');
    const tooltip = page.getByRole('tooltip').filter({ hasText: /^\d/ });
    fixture.state.releasePoll = false;
    await expect(gauge).toHaveAccessibleName('Контекст разговора: 0/65.5K');

    // Act: отправить запрос и получить первый снимок прогресса.
    fixture.state.pollFrames = [{
      status: 'running',
      progress: { stepsUsed: 1, contextTokens: 2_000, contextLimitTokens: 1_000_000, events: [{ kind: 'model' }] }
    }];
    await textbox.fill('Проверь заполнение контекста');
    await composer.getByRole('button', { name: 'Отправить', exact: true }).click();

    // Assert: наведение и переход с клавиатуры показывают одну и ту же оценку.
    await expect(gauge).toHaveAccessibleName('Контекст разговора: 2K/1M');
    await page.mouse.move(0, 0);
    await gauge.hover();
    await expect(tooltip).toHaveText('2K/1M');
    await page.mouse.move(0, 0);
    await expect(tooltip).toBeHidden();
    await textbox.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(gauge).toBeFocused();
    await expect(tooltip).toHaveText('2K/1M');
    await fixture.shot(page, 'chat-context-keyboard');

    fixture.state.pollFrames = [{
      status: 'done', answer: 'Измерение готово.', cites: [], changed: [],
      progress: { stepsUsed: 2, contextTokens: 4_000, contextLimitTokens: 1_000_000, events: [{ kind: 'model' }] }
    }];
    await expect(panel.getByText('Измерение готово.')).toBeVisible();
    await expect(gauge).toHaveAccessibleName('Контекст разговора: 4K/1M');

    // Act: создать пустой разговор и вернуться к первому.
    await panel.getByRole('button', { name: 'Новый разговор' }).click();
    await expect(panel.getByRole('heading', { name: 'Спросите о проекте' })).toBeVisible();
    await expect(gauge).toHaveAccessibleName('Контекст разговора: 0/65.5K');
    await panel.getByRole('button', { name: /История разговоров/ }).click();
    await page.getByRole('option', { name: 'Первый разговор' }).click();

    // Assert: после возврата видна оценка первого разговора.
    await expect(panel.getByText('Измерение готово.')).toBeVisible();
    await expect(gauge).toHaveAccessibleName('Контекст разговора: 4K/1M');
  });

  test('Порядок поиска меняется в настройках и сохраняется для следующего запроса', { timeout }, async t => {
    // Arrange: в чате нет переключателя. Настройки открываются из заголовка чата.
    const fixture = getFixture();
    const { page, panel } = await fixture.open(t);
    await expect(panel.getByText(/Сначала документы|Сначала код/)).toHaveCount(0);
    const settings = panel.getByRole('button', { name: 'Настройки агента' });
    const dialog = page.getByRole('dialog', { name: 'Настройки' });
    const context = dialog.getByRole('option', { name: 'Контекст', exact: true });
    const docs = dialog.getByRole('radio', { name: 'Сначала документы', exact: true });
    const code = dialog.getByRole('radio', { name: 'Сначала код', exact: true });
    await settings.click();
    await context.click();
    await expect(docs).toBeChecked();

    // Act: выбрать код, перезагрузить страницу и отправить запрос.
    await dialog.getByText('Сначала код', { exact: true }).click();
    await expect(code).toBeChecked();
    await page.reload();
    await settings.click();
    await context.click();
    await expect(code).toBeChecked();
    await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
    await panel.getByRole('textbox', { name: 'Сообщение агенту' }).fill('Сначала поищи код');
    await panel.getByRole('button', { name: 'Отправить', exact: true }).click();

    // Assert: сервер получил сохранённый порядок поиска.
    await expect.poll(() => fixture.state.submitted?.search).toBe('codeFirst');
  });

  test('Enter отправляет многострочный текст, а Shift+Enter добавляет строку без отправки', { timeout }, async t => {
    // Arrange: поле заполнено, подсказки с сочетаниями клавиш нет.
    const fixture = getFixture();
    const { page, panel } = await fixture.open(t);
    const textbox = panel.getByRole('textbox', { name: 'Сообщение агенту' });
    await expect(panel.getByText(/Shift\s*\+\s*Enter/i)).toHaveCount(0);
    await textbox.fill('Первая строка');

    // Act: добавить вторую строку с клавиатуры и отправить.
    await textbox.press('End');
    await textbox.press('Shift+Enter');
    await expect(textbox).toHaveValue('Первая строка\n');
    assert.equal(fixture.state.submitted, undefined);
    await page.keyboard.insertText('Вторая строка');
    await textbox.press('Enter');

    // Assert: сервер получил один запрос с переводом строки внутри текста.
    await expect.poll(() => fixture.state.submitted?.text).toBe('Первая строка\nВторая строка');
    const posts = fixture.state.requests.filter(item => item.method === 'POST' && item.path.endsWith('/turns'));
    assert.equal(posts.length, 1);
  });
}
