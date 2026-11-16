import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { generateToken, isAuthorized } from '../core/auth';
import { withLineNumbers } from '../core/paths';

/** Editor capabilities the tools need. Injected so this module has no `vscode` import. */
export interface ToolHost {
  /** Throws (with a message for the model) unless `runToken` belongs to the active run. */
  checkRun(runToken: string): void;
  /** Returns the current text of a workspace-relative file (throws if missing or outside). */
  readText(path: string): Promise<string>;
  /** Runs a write tool through the transaction manager. Never writes outside a review. */
  execute(runToken: string, tool: 'propose_write' | 'replace_selection', args: unknown): Promise<{ text: string; isError: boolean }>;
  log(line: string): void;
}

export interface RunningMcpServer {
  /** Base URL; a run's tools are served at `${url}/${runToken}`. */
  url: string;
  token: string;
  /** URL to register for one run. */
  urlForRun(runToken: string): string;
  close(): Promise<void>;
}

const MCP_PATH = '/mcp';

function text(t: string, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

function oneLine(t: string): string {
  return t.replace(/\s*\n\s*/g, ' | ');
}

function buildServer(host: ToolHost, runToken: string): McpServer {
  const server = new McpServer({ name: 'ripple', version: '0.0.1' });

  server.registerTool(
    'read_file',
    {
      description:
        'Read a text file in the workspace. Returns the content with 1-based line numbers ' +
        '(the numbers are not part of the file). Optionally limit to lines start..end (inclusive).',
      inputSchema: {
        path: z.string().describe('Workspace-relative path, e.g. "src/app.ts".'),
        start: z.number().int().min(1).optional(),
        end: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, start, end }) => {
      host.log(`[mcp] read_file path=${path} start=${start ?? '-'} end=${end ?? '-'}`);
      try {
        host.checkRun(runToken);
        const content = await host.readText(path);
        return text(withLineNumbers(content, start, end));
      } catch (err) {
        return text(`read_file failed: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  );

  server.registerTool(
    'propose_write',
    {
      description:
        'Propose edits to one workspace file. The user reviews every change hunk by hunk; only ' +
        'accepted hunks are written. Each edit replaces old_text (copied exactly from the file, ' +
        'without line numbers, occurring exactly once) with new_text. The result states for each ' +
        'hunk whether it was applied or rejected by the user; do not claim more than it says.',
      inputSchema: {
        path: z.string().describe('Workspace-relative path.'),
        edits: z
          .array(
            z.object({
              old_text: z.string().describe('Exact existing text to replace. Must occur exactly once.'),
              new_text: z.string().describe('Replacement text.'),
            }),
          )
          .min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      host.log(`[mcp] propose_write path=${args.path} edits=${args.edits.length}`);
      const out = await host.execute(runToken, 'propose_write', args);
      host.log(`[mcp] propose_write → ${oneLine(out.text)}`);
      return text(out.text, out.isError);
    },
  );

  server.registerTool(
    'replace_selection',
    {
      description:
        'Inline edit only: replace the lines the user selected with new_text (the complete new ' +
        'version of those lines, same indentation, no line numbers, no Markdown fences). The ' +
        'user reviews the change hunk by hunk before anything is written.',
      inputSchema: {
        new_text: z.string().describe('Complete replacement for the selected lines.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      host.log(`[mcp] replace_selection chars=${args.new_text.length}`);
      const out = await host.execute(runToken, 'replace_selection', args);
      host.log(`[mcp] replace_selection → ${oneLine(out.text)}`);
      return text(out.text, out.isError);
    },
  );

  return server;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

/** Starts the MCP server on 127.0.0.1 at a random free port, protected by a bearer token. */
export async function startMcpServer(host: ToolHost): Promise<RunningMcpServer> {
  const token = generateToken();

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // A run's tools live at /mcp/<runToken>; the token binds every call to that run.
      const match = /^\/mcp\/([A-Za-z0-9_-]{8,})$/.exec(url.pathname);
      if (!match?.[1]) return sendJson(res, 404, { error: 'not found' });
      const runToken = match[1];
      if (!isAuthorized(req.headers.authorization, token)) {
        host.log(`[mcp] rejected ${req.method} without a valid bearer token`);
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      if (req.method !== 'POST') {
        // Stateless mode: no server-initiated SSE stream and no sessions to delete.
        return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
      }
      // Stateless: a fresh server and transport per request.
      const server = buildServer(host, runToken);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((err: unknown) => {
      host.log(`[mcp] request failed: ${String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;

  const base = `http://127.0.0.1:${port}${MCP_PATH}`;
  return {
    url: base,
    token,
    urlForRun: (runToken) => `${base}/${runToken}`,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}
