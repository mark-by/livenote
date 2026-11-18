// allow: SIZE_OK — плоские декларации MCP-инструментов и схем делят один NoteService.
/**
 * MCP-слой LiveNote: Streamable HTTP на /mcp, stateless-паттерн SDK v1.
 * На каждый POST /mcp создаётся новый McpServer + транспорт (кэшируемых сессий нет),
 * инструменты — тонкие обёртки над NoteService, чтобы поведение совпадало с REST.
 */
import express from 'express';
import type { Express, RequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { LIVENOTE_VERSION } from '../../shared/types.js';
import { AppError } from '../errors.js';
import type { ServerDeps } from '../ports.js';

interface McpVaults {
  list(): Array<{ readonly id: string; readonly name: string }>;
  resolve(vaultId?: string): ServerDeps;
}

export function mountMcp(app: Express, deps: ServerDeps, vaults?: McpVaults): void {
  app.post('/mcp', bearerAuth(deps), express.json({ limit: '10mb' }), handleMcpPost(deps, vaults));
  // SSE-стрим MCP и удаление сессий не поддерживаем — только POST с JSON-ответом.
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}

// ---------------------------------------------------------------------------
// HTTP-обработчики
// ---------------------------------------------------------------------------

/** Bearer-токен на /mcp; если токен не задан — аутентификация отключена. */
function bearerAuth(deps: ServerDeps): RequestHandler {
  return (req, res, next) => {
    const token = deps.config.token;
    if (token === null || token.length === 0) {
      next();
      return;
    }
    if (req.headers.authorization === `Bearer ${token}`) {
      next();
      return;
    }
    res.status(401).json({
      error: { code: 'unauthorized', message: 'Требуется корректный bearer-токен' }
    });
  };
}

/** Stateful-каналы MCP не поддерживаются: GET (SSE) и DELETE (закрытие сессии) — 405. */
function methodNotAllowed(_req: express.Request, res: express.Response): void {
  res.setHeader('Allow', 'POST');
  res.status(405).json({
    error: { code: 'method_not_allowed', message: 'Поддерживается только POST /mcp' }
  });
}

/** Новый McpServer+transport на каждый запрос; ошибки handleRequest → 500 либо закрытие соединения. */
function handleMcpPost(deps: ServerDeps, vaults?: McpVaults): RequestHandler {
  return async (req, res) => {
    try {
      const server = buildMcpServer(deps, vaults);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless: без сессий
        enableJsonResponse: true
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (res.headersSent) {
        // Ответ уже начат (например, SSE-фрагмент) — остаётся закрыть соединение.
        res.end();
        return;
      }
      console.error('[livenote] ошибка MCP-запроса:', error);
      const message = error instanceof Error ? error.message : 'Внутренняя ошибка MCP-запроса';
      res.status(500).json({ error: { code: 'internal', message } });
    }
  };
}

// ---------------------------------------------------------------------------
// Сборка McpServer с инструментами
// ---------------------------------------------------------------------------

function buildMcpServer(deps: ServerDeps, vaults?: McpVaults): McpServer {
  const server = new McpServer({ name: 'livenote', version: LIVENOTE_VERSION });
  const vaultField = z.string().optional().describe('Vault ID from list_vaults. Required when more than one vault is open.');
  const vaultInput: { readonly vault_id?: typeof vaultField } = vaults ? { vault_id: vaultField } : {};
  type ToolAction = (service: ServerDeps['service']) => CallToolResult | Promise<CallToolResult>;
  const storageTool = (vaultId: string | undefined, run: ToolAction) =>
    safeTool(() => run((vaults ? vaults.resolve(vaultId) : deps).service));

  // У этих инструментов в режиме SQLite нет схемы аргументов.
  const registerStorageRead = (name: string, description: string, run: ToolAction) => {
    if (vaults) {
      const inputSchema = z.object({ vault_id: vaultField });
      // MCP допускает вызов без arguments. SDK передаёт undefined прямо в схему.
      const parse = inputSchema.safeParseAsync.bind(inputSchema);
      inputSchema.safeParseAsync = (input, params) => parse(input === undefined ? {} : input, params);
      server.registerTool(name, { description, inputSchema },
        args => storageTool(args.vault_id, run));
    } else {
      server.registerTool(name, { description }, () => storageTool(undefined, run));
    }
  };

  if (vaults) {
    server.registerTool('list_vaults', {
      description: 'List open vaults and their IDs for use with vault_id.',
      outputSchema: { vaults: z.array(z.object({ id: z.string(), name: z.string() })) }
    }, () => safeTool(() => {
      const result = { vaults: vaults.list().map(({ id, name }) => ({ id, name })) };
      return { ...jsonResult(result), structuredContent: result };
    }));
  }

  // Схемы полей: ZodRawShape (объект zod-полей, НЕ z.object) — так требует registerTool SDK.
  const pageIdField = z.string().describe('Vault: root-relative document path with extension; SQLite: page ID');
  const blockIdField = z
    .string()
    .describe(
      'Vault: transient span ID from the current revision, must exist. Omit to insert at at/EOF. SQLite: stable block ID'
    );
  const expectedRevisionField = z
    .number()
    .int()
    .describe('Page revision the caller has seen; mismatch -> conflict error with details.currentRevision');
  const requestIdField = z
    .string()
    .optional()
    .describe('Optional idempotency key; repeating the call with the same key returns the stored result instead of duplicating it');

  registerStorageRead(
    'list_pages',
    'List all pages: id, title, revision, createdAt, updatedAt. No block contents.',
    service => jsonResult(service.listPages())
  );

  server.registerTool(
    'get_page',
    {
      description:
        'Get a full page by id: title, current revision and all blocks in display order (markdown sources and mermaid, BPMN or draw.io diagrams).',
      inputSchema: { ...vaultInput, page_id: pageIdField }
    },
    (args) => storageTool(args.vault_id, service => jsonResult(service.getPage(args.page_id)))
  );

  server.registerTool(
    'add_page',
    {
      description: 'Create a new empty page and return its id and revision. Use request_id for safe retries.',
      inputSchema: { ...vaultInput, title: z.string().describe('Page title'), path: z.string().optional(), source: z.string().optional(), format: z.enum(['mermaid', 'bpmn', 'drawio']).optional(), request_id: requestIdField }
    },
    (args) =>
      storageTool(args.vault_id, async service => {
        const page = await service.createDocument({ title: args.title, path: args.path, source: args.source, format: args.format, requestId: args.request_id });
        return jsonResult({ page_id: page.id, title: page.title, revision: page.revision });
      })
  );

  server.registerTool(
    'write_markdown',
    {
      description:
        'Create or fully replace a markdown block. On a conflict nothing changes — read the page again and retry with the fresh revision.',
      inputSchema: {
        ...vaultInput,
        page_id: pageIdField,
        block_id: blockIdField.optional(),
        at: z.number().int().nonnegative().optional(),
        expected_version: z.string().optional(),
        expected_revision: expectedRevisionField,
        source: z.string().describe('Markdown source of the block (plain text)'),
        request_id: requestIdField
      }
    },
    (args) =>
      storageTool(args.vault_id, async service =>
        jsonResult(
          await service.writeBlock(args.page_id, args.block_id, 'markdown', args.source, args.expected_revision, args.request_id, { at: args.at, expectedVersion: args.expected_version })
        )
      )
  );

  server.registerTool(
    'write_diagram',
    {
      description:
        'Create or fully replace a diagram block (mermaid, bpmn or drawio). source is CLEAN Mermaid WITHOUT ``` fences, a BPMN 2.0 XML document OR draw.io mxfile/mxGraphModel XML. ' +
        'On a syntax error the new version is NOT saved (page revision unchanged) — fix source per validation.error.message and retry. ' +
        'For BPMN without BPMNDI geometry pass layout: "auto" (or publish first and call layout_diagram later). ' +
        'BPMN lint findings (validation.lint) do NOT block publishing, but you should address them. ' +
        'For complex diagrams: publish a minimal correct version first, then refine it with successive meaningful updates — the user sees changes in real time; do not postpone publishing until the end of your work.',
      inputSchema: {
        ...vaultInput,
        page_id: pageIdField,
        block_id: blockIdField.optional(),
        at: z.number().int().nonnegative().optional(),
        expected_version: z.string().optional(),
        expected_revision: expectedRevisionField,
        format: z.enum(['mermaid', 'bpmn', 'drawio']).default('mermaid').describe('Diagram format'),
        source: z.string().describe('Diagram source: clean Mermaid without ```mermaid fences, BPMN 2.0 XML or draw.io mxfile/mxGraphModel XML'),
        layout: z
          .enum(['preserve', 'auto'])
          .optional()
          .describe(
            'BPMN layout mode: preserve (use geometry from XML, fails without BPMNDI) or auto (recalculate layout; manual positions may change)'
          ),
        title: z
          .string()
          .optional()
          .describe(
            'Optional diagram title displayed ABOVE the diagram as an HTML heading (it is NOT part of the SVG). Omit to keep the existing title; pass an empty string to remove it.'
          ),
        request_id: requestIdField
      }
    },
    (args) =>
      storageTool(args.vault_id, async service =>
        jsonResult(
          await service.writeBlock(
            args.page_id,
            args.block_id,
            args.format,
            args.source,
            args.expected_revision,
            args.request_id,
            // Раскладка имеет смысл только для BPMN; mermaid и drawio идут без layout.
            // title — название над схемой (HTML, вне SVG); undefined — не менять.
            {
              layout: args.format === 'bpmn' ? args.layout : undefined,
              title: args.title, at: args.at, expectedVersion: args.expected_version
            }
          )
        )
      )
  );

  server.registerTool(
    'check_diagram',
    {
      description:
        "Validate a diagram block. mode 'syntax' (default) runs parsing only: mermaid.parse for mermaid blocks, BPMN 2.0 XML parsing + bpmnlint for bpmn blocks (findings in validation.lint), draw.io XML parsing for drawio blocks; " +
        "mode 'render' fully renders (mermaid, bpmn-js or the local draw.io editor) and returns the validation result only — no image is attached (agents should not try to view it; a human can get a PNG via REST /pages/:pageId/blocks/:blockId/png). " +
        'The service picks the checks by block type. If the passed revision is outdated, the check is skipped (stale=true) — re-read the page first.',
      inputSchema: {
        ...vaultInput,
        page_id: pageIdField,
        block_id: z.string().describe('Diagram block id to check'),
        revision: z
          .number()
          .int()
          .optional()
          .describe('Expected current page revision; if it differs from the actual one, the check is skipped (stale=true)'),
        mode: z.enum(['syntax', 'render']).default('syntax').describe("'syntax' (parse only) or 'render' (full rendering)")
      }
    },
    (args) =>
      storageTool(args.vault_id, async service => {
        const result = await service.checkDiagram(args.page_id, args.block_id, {
          revision: args.revision,
          mode: args.mode
        });
        // Изображение агентам не отдаём — вырезаем render-объект с base64 из ответа;
        // PNG для человека доступен через REST /pages/:pageId/blocks/:blockId/png.
        const payload = { ...result, render: undefined };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }]
        };
      })
  );

  server.registerTool(
    'layout_diagram',
    {
      description:
        'Recalculate the BPMN diagram layout (bpmn-auto-layout) and publish it as a new revision. Only for bpmn blocks.',
      inputSchema: {
        ...vaultInput,
        page_id: pageIdField,
        block_id: z.string().describe('BPMN block id to re-layout'),
        expected_revision: expectedRevisionField
      }
    },
    (args) =>
      storageTool(args.vault_id, async service =>
        jsonResult(await service.layoutDiagram(args.page_id, args.block_id, args.expected_revision))
      )
  );

  server.registerTool(
    'update_page',
    {
      description: 'Rename a page and/or reorder and delete blocks in one atomic operation guarded by expected_revision.',
      inputSchema: {
        ...vaultInput,
        page_id: pageIdField,
        expected_revision: expectedRevisionField,
        title: z.string().optional().describe('New page title'),
        block_order: z
          .array(z.string())
          .optional()
          .describe('New display order: array of block ids, exactly the blocks remaining on the page'),
        delete_block_ids: z.array(z.string()).optional().describe('Block ids to delete')
      }
    },
    (args) =>
      storageTool(args.vault_id, service =>
        jsonResult(
          service.updatePage(
            args.page_id,
            { title: args.title, blockOrder: args.block_order, deleteBlockIds: args.delete_block_ids },
            args.expected_revision
          )
        )
      )
  );

  server.registerTool(
    'delete_page',
    {
      description: 'Permanently delete a page guarded by expected_revision.',
      inputSchema: { ...vaultInput, page_id: pageIdField, expected_revision: expectedRevisionField, expected_version: z.string().optional() }
    },
    (args) =>
      storageTool(args.vault_id, async service => {
        await service.deletePage(args.page_id, args.expected_revision, args.expected_version);
        return { content: [{ type: 'text', text: 'Страница удалена окончательно' }] };
      })
  );

  registerStorageRead('get_vault', 'List native files, empty folders, tags and current treeVersion.',
    service => jsonResult(service.vaultSnapshot()));
  server.registerTool('get_document', { description: 'Read exact native source, transient UTF-16 spans and asset versions by path.', inputSchema: { ...vaultInput, path: z.string() } },
    args => storageTool(args.vault_id, service => jsonResult(service.getDocument(args.path))));
  server.registerTool('write_document', {
    description: 'Atomically save exact source and diagram assets, guarded by document and asset versions. Paths are root-relative.',
    inputSchema: {
      ...vaultInput,
      path: z.string(), expected_revision: expectedRevisionField, expected_version: z.string(), source: z.string(), request_id: requestIdField,
      assets: z.array(z.object({ path: z.string(), source: z.string(), expected_version: z.string().nullable(), layout: z.enum(['preserve', 'auto']).optional() })).optional(),
      references: z.array(z.object({ path: z.string(), expected_version: z.string() })).optional()
    }
  }, args => storageTool(args.vault_id, async service => jsonResult(await service.writeDocument(args.path, {
    expectedRevision: args.expected_revision, expectedVersion: args.expected_version, source: args.source, requestId: args.request_id,
    assets: args.assets?.map(asset => ({ path: asset.path, source: asset.source, expectedVersion: asset.expected_version, layout: asset.layout })),
    references: args.references?.map(reference => ({ path: reference.path, expectedVersion: reference.expected_version }))
  }))));
  server.registerTool('create_folder', { description: 'Create a real folder, including empty parents, guarded by tree version.', inputSchema: { ...vaultInput, path: z.string(), expected_tree_version: z.string() } },
    args => storageTool(args.vault_id, service => jsonResult(service.createFolder(args.path, args.expected_tree_version))));
  server.registerTool('move_folder', { description: 'Move a folder subtree and rewrite resolved relative links atomically.', inputSchema: { ...vaultInput, from: z.string(), path: z.string(), expected_tree_version: z.string() } },
    args => storageTool(args.vault_id, service => jsonResult(service.moveFolder(args.from, args.path, args.expected_tree_version))));
  server.registerTool('delete_folder', { description: 'Permanently delete a folder. Nonempty folders require recursive:true.', inputSchema: { ...vaultInput, path: z.string(), expected_tree_version: z.string(), recursive: z.boolean().optional() } },
    args => storageTool(args.vault_id, service => jsonResult(service.deleteFolder(args.path, args.expected_tree_version, args.recursive))));
  server.registerTool('move_document', { description: 'Rename or move a native document path and rewrite incoming/outgoing links.', inputSchema: { ...vaultInput, path: z.string(), to: z.string(), expected_revision: expectedRevisionField, expected_version: z.string() } },
    args => storageTool(args.vault_id, service => jsonResult(service.movePage(args.path, { path: args.to, expectedRevision: args.expected_revision, expectedVersion: args.expected_version }))));

  return server;
}

// ---------------------------------------------------------------------------
// Хелперы результатов инструментов
// ---------------------------------------------------------------------------

/** Обычный результат: JSON значения в text-контенте. */
function jsonResult(result: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

/**
 * Единая обработка ошибок инструментов: AppError → isError-результат с кодом и данными.
 * Остальные ошибки пробрасываются — SDK сам вернёт их клиенту как isError с текстом.
 */
async function safeTool(run: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) {
      const details = error.details !== undefined ? ` Данные: ${JSON.stringify(error.details)}` : '';
      return {
        content: [{ type: 'text', text: `Ошибка [${error.code}]: ${error.message}${details}` }],
        isError: true
      };
    }
    throw error;
  }
}
