import { after, before, test } from 'node:test';
import { chromium, expect } from 'playwright/test';

const base = process.env.LIVENOTE_TEST_URL;
if (!base) throw new Error('Задайте LIVENOTE_TEST_URL отдельного vault-сервера.');

const timeout = 30_000;
const assertionTimeout = 2_000;
let browser;

before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
});

async function openSettings(page) {
  await page.getByRole('button', { name: 'Меню LiveNote' }).click();
  await page.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  await dialog.getByRole('option', { name: 'Редактор', exact: true }).click();
  return dialog;
}

for (const setting of [
  { name: 'Режим Vim', key: 'livenote_vim' },
  { name: 'Следовать за изменениями', key: 'livenote_follow' }
]) {
  for (const target of ['control', 'thumb', 'label', 'keyboard']) {
    test(`${setting.name}: ${target} меняет настройку и сохраняет её после перезагрузки`, { timeout }, async (t) => {
      // Arrange: отдельный профиль начинает проверку с выключенной настройкой.
      const context = await browser.newContext();
      t.after(() => context.close());
      const page = await context.newPage();
      await page.goto(base);
      await page.evaluate((key) => localStorage.setItem(key, '0'), setting.key);
      await page.reload();
      const dialog = await openSettings(page);
      const field = dialog.locator('[data-slot="switch"]').filter({ hasText: setting.name });
      const input = dialog.getByRole('switch', { name: setting.name });
      await expect(input).not.toBeChecked();

      // Act: включаем настройку указанным способом.
      if (target === 'keyboard') {
        await input.focus();
        await page.keyboard.press('Space');
      } else {
        const slot = target === 'label' ? 'label' : `switch-${target}`;
        await field.locator(`[data-slot="${slot}"]`).click();
      }

      // Assert: состояние остаётся включённым после перезагрузки приложения.
      await expect(input).toBeChecked({ timeout: assertionTimeout });
      await page.reload();
      const reopened = await openSettings(page);
      await expect(reopened.getByRole('switch', { name: setting.name })).toBeChecked({ timeout: assertionTimeout });
    });
  }
}
