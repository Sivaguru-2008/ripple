import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { generateToken, isAuthorized } from '../core/auth';
import { withLineNumbers } from '../core/paths';

export interface LineEdit {
  start_line: number;
  end_line: number;
  new_text: string;
}

export interface WriteProposal {
  epoch: number;
  path: string;
  edits: LineEdit[];
}

/** Editor capabilities the tools need. Injected so this module has no `vscode` import. */
export interface ToolHost {
  /** Returns the current text of a workspace-relative file (throws if missing or outside). */
  readText(path: string): Promise<string>;
  /** Called for every proposal. Must not touch disk. */
  onProposal(proposal: WriteProposal): void;
  log(line: string): void;
}

export interface RunningMcpServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

const MCP_PATH = '/mcp';

function buildServer(host: ToolHost): McpServer {
  const server = new McpServer({ name: 'ripple', version: '0.0.1' });

  server.registerTool(
    'read_file',
    {
      description:
        'Read a text file in the workspace. Returns the content with 1-based line numbers. ' +
        'Optionally limit to lines start..end (inclusive).',
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
        const text = await host.readText(path);
        return { content: [{ type: 'text', text: withLineNumbers(text, start, end) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `read_file failed: ${String(err)}` }] };
      }
    },
  );

  server.registerTool(
    'propose_write',
    {
      description:
        'Propose edits to one workspace file. Nothing is written until the user reviews and ' +
        'accepts. Each edit replaces lines start_line..end_line (1-based, inclusive) with ' +
        'new_text; use end_line = start_line - 1 to insert before start_line.',
      inputSchema: {
        epoch: z.number().int().min(0).describe('Run epoch given in the instructions.'),
        path: z.string().describe('Workspace-relative path.'),
        edits: z
          .array(
            z.object({
              start_line: z.number().int().min(1),
              end_line: z.number().int().min(0),
              new_text: z.string(),
            }),
          )
          .min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      // Day 1: log only. Staging and review come with the TransactionManager.
      host.onProposal(args);
      return {
        content: [{ type: 'text', text: `staged: ${args.edits.length} edit(s) to ${args.path} (epoch ${args.epoch})` }],
      };
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
      if (url.pathname !== MCP_PATH) return sendJson(res, 404, { error: 'not found' });
      if (!isAuthorized(req.headers.authorization, token)) {
        host.log(`[mcp] rejected ${req.method} without a valid bearer token`);
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      if (req.method !== 'POST') {
        // Stateless mode: no server-initiated SSE stream and no sessions to delete.
        return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
      }
      // Stateless: a fresh server and transport per request.
      const server = buildServer(host);
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

  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}
