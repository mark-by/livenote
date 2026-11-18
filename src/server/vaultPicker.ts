import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { json } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, InvalidRequestError, serverClosing } from './errors.js';
import { vaultNotFound } from './vaultRegistry.js';
import type { VaultRegistry } from './vaultRegistry.js';

const EMPTY_BODY = z.object({}).strict();
const parseJson = json({ limit: '1kb' });
// osascript запускается в режиме prohibited. Режим accessory разрешает фокус без значка в Dock.
const CHOOSE_FOLDER = `
ObjC.import('AppKit');

function run() {
  const app = $.NSApplication.sharedApplication;
  if (!app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)) {
    throw new Error('Не удалось разрешить активацию диалога');
  }
  app.finishLaunching;

  const panel = $.NSOpenPanel.openPanel;
  panel.title = 'LiveNote';
  panel.message = 'Выберите каталог для LiveNote';
  panel.canChooseFiles = false;
  panel.canChooseDirectories = true;
  panel.canCreateDirectories = false;
  panel.allowsMultipleSelection = false;

  // Браузер не передаёт фокус по API совместной активации.
  app.activateIgnoringOtherApps(true);
  const response = Number(panel.runModal);
  if (response === Number($.NSModalResponseCancel)) return 'cancelled';
  if (response !== Number($.NSModalResponseOK)) throw new Error('Неизвестный результат выбора каталога');
  return ObjC.unwrap(panel.URL.path);
}
`;

export type ChooseFolder = (signal: AbortSignal) => Promise<string | null>;

function chooseMacFolder(signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const args = ['-l', 'JavaScript', '-e', CHOOSE_FOLDER];
    const child = execFile('/usr/bin/osascript', args, (error, stdout) => {
      signal.removeEventListener('abort', abort);
      const path = stdout.replace(/\n$/, '');
      if (signal.aborted || (error === null && path === 'cancelled')) resolve(null);
      else if (error !== null) reject(new Error('Не удалось открыть системный диалог', { cause: error }));
      else if (!isAbsolute(path)) reject(new Error('Системный диалог не вернул абсолютный путь'));
      else resolve(path);
    });
    const abort = (): void => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export class VaultPicker {
  private readonly chooseFolder?: ChooseFolder;
  private active?: { readonly controller: AbortController; readonly selection: Promise<string | null> };
  private closing = false;

  constructor(private readonly registry: VaultRegistry | undefined, chooseFolder?: ChooseFolder) {
    if (registry !== undefined) this.chooseFolder = chooseFolder ?? (process.platform === 'darwin' ? chooseMacFolder : undefined);
  }

  get available(): boolean {
    return this.chooseFolder !== undefined && !this.closing;
  }

  readonly guards: RequestHandler = (req, _res, next) => {
    const site = req.get('sec-fetch-site');
    const origin = req.get('origin')?.toLowerCase();
    // Прокси Vite может изменить Host для запроса, который браузер отправил со своего origin.
    const sameOrigin = origin === undefined || origin === `http://${req.get('host')?.toLowerCase()}` || site === 'same-origin';
    if (!sameOrigin || (site !== undefined && site !== 'same-origin' && site !== 'none')) {
      throw new AppError('forbidden_origin', 'Диалог доступен только из интерфейса LiveNote', 403);
    }
    if (this.registry === undefined) throw vaultNotFound();
    if (!req.is('application/json')) {
      throw new AppError('unsupported_media_type', 'Требуется Content-Type: application/json', 415);
    }
    if (Object.keys(req.query).length !== 0) throw new InvalidRequestError('Параметры запроса не поддерживаются');
    next();
  };

  readonly parseBody: RequestHandler = (req, res, next) => {
    parseJson(req, res, (error?: unknown) => {
      if (error instanceof SyntaxError) next(new InvalidRequestError('Требуется пустой JSON-объект'));
      else next(error);
    });
  };

  readonly handleOpen: RequestHandler = (req, res, next) => {
    if (!EMPTY_BODY.safeParse(req.body).success) throw new InvalidRequestError('Требуется пустой JSON-объект');
    if (this.closing) throw serverClosing();
    const { registry, chooseFolder } = this;
    if (registry === undefined || chooseFolder === undefined) {
      throw new AppError('folder_picker_unavailable', 'Системный диалог недоступен', 503);
    }
    if (this.active !== undefined) throw new AppError('folder_picker_busy', 'Диалог выбора каталога уже открыт', 409);

    const controller = new AbortController();
    const onClose = (): void => { controller.abort(); };
    res.once('close', onClose);
    const selection = Promise.resolve().then(() => controller.signal.aborted ? null : chooseFolder(controller.signal));
    this.active = { selection, controller };
    void selection.then(path => {
      if (res.destroyed) return;
      if (this.closing) throw serverClosing();
      const vault = path === null ? null : registry.openSelected(path);
      res.json({ vault });
    }).catch(next).finally(() => {
      res.off('close', onClose);
      this.active = undefined;
    });
  };

  async close(): Promise<void> {
    this.closing = true;
    const { active } = this;
    if (active === undefined) return;
    active.controller.abort();
    await Promise.allSettled([active.selection]);
  }
}
