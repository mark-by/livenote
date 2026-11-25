import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { BoundedCache, withTimeout } from '../src/server/validator/limits.js';
import { NodeBrowserBpmnValidator } from '../src/server/validator/bpmn.js';
import { PlaywrightValidator } from '../src/server/validator/playwright.js';

const timeoutMs = 15_000;
const bpmnSource = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
 xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
 xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
 id="definitions" targetNamespace="http://example.org">
 <bpmn:process id="process"><bpmn:startEvent id="start"/></bpmn:process>
 <bpmndi:BPMNDiagram id="diagram"><bpmndi:BPMNPlane id="plane" bpmnElement="process">
 <bpmndi:BPMNShape id="shape" bpmnElement="start"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
 </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

test('validator: повторная запись меняет порядок вытеснения', () => {
  // Arrange: заполняем кеш и обновляем первую запись.
  const cache = new BoundedCache<number>(2);
  cache.set('first', 1);
  cache.set('second', 2);
  cache.set('first', 3);

  // Act: добавляем запись сверх лимита.
  cache.set('third', 4);

  // Assert: вытеснена самая старая запись, а обновлённая сохранена.
  assert.equal(cache.get('first'), 3);
  assert.equal(cache.get('second'), undefined);
  assert.equal(cache.get('third'), 4);
});

test('validator: успешный ответ очищает собственный таймер', async (t) => {
  // Arrange: отслеживаем создание и очистку таймера.
  const setTimer = t.mock.method(globalThis, 'setTimeout');
  const clearTimer = t.mock.method(globalThis, 'clearTimeout');

  // Act: операция завершается до таймаута.
  const result = await withTimeout(Promise.resolve('готово'), 'проверка', timeoutMs);

  // Assert: очищен именно таймер этой операции.
  assert.equal(result, 'готово');
  assert.equal(setTimer.mock.callCount(), 1);
  assert.equal(clearTimer.mock.callCount(), 1);
  assert.equal(clearTimer.mock.calls[0]?.arguments[0], setTimer.mock.calls[0]?.result);
});

test('validator: таймаут отклоняет незавершённую операцию', async (t) => {
  // Arrange: включаем управляемые таймеры.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = withTimeout(new Promise<never>(() => {}), 'проверка', timeoutMs);
  const rejected = assert.rejects(result, /15000/);

  // Act: наступает срок таймаута.
  t.mock.timers.tick(timeoutMs);

  // Assert: операция завершается ошибкой.
  await rejected;
});

test('validator: Mermaid проверяет и кеширует результат в браузере', async () => {
  // Arrange: отдельный браузер принадлежит этому тесту.
  const browser = await chromium.launch({ headless: true });
  const validator = new PlaywrightValidator('default');
  Reflect.set(validator, 'browser', browser);
  try {
    // Act: проверяем один источник дважды.
    const first = await validator.parse('flowchart LR\n A --> B');
    const second = await validator.parse('flowchart LR\n A --> B');

    // Assert: проверка выполнена, повтор использует кеш.
    assert.equal(first.syntax, 'ok');
    assert.equal(second, first);
  } finally {
    await browser.close();
  }
});

test('validator: BPMN проверяет и кеширует рисунок в браузере', async () => {
  // Arrange: отдельный браузер принадлежит этому тесту.
  const browser = await chromium.launch({ headless: true });
  const validator = new NodeBrowserBpmnValidator();
  Reflect.set(validator, 'browser', browser);
  try {
    // Act: рисуем один источник дважды.
    const first = await validator.render(bpmnSource);
    const second = await validator.render(bpmnSource);

    // Assert: рисунок создан, повтор использует кеш.
    assert.equal(first.validation.syntax, 'ok');
    assert.match(first.render?.svg ?? '', /<svg/);
    assert.equal(second, first);
  } finally {
    await browser.close();
  }
});
