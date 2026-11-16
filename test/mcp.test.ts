import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, type RunningMcpServer } from '../src/mcp/server';
import { TransactionManager } from '../src/core/transactions';

const files: Record<string, string> = { 'README.md': '# Title\nline two' };
const tx = new TransactionManager({
  readText: async (p) => {
    const t = files[p];
    if (t === undefined) throw new Error(`no such file: ${p}`);
    return t;
  },
  applyEdits: async (p, base, edits) => {
    if (files[p] !== base) return 'changed';
    let t = base;
    for (const e of [...edits].sort((a, b) => b.start - a.start)) t = t.slice(0, e.start) + e.text + t.slice(e.end);
    files[p] = t;
    return 'ok';
  },
  // Review: accept every hunk.
  review: async (p) => p.hunks.forEach((h) => tx.decide(p.id, h.id, true)),
});
let running: RunningMcpServer;

beforeAll(async () => {
  running = await startMcpServer({
    checkRun: (token) => void tx.requireActive(token),
    readText: async (p) => {
      const t = files[p];
      if (t === undefined) throw new Error(`no such file: ${p}`);
      return t;
    },
    execute: (token, tool, args) => tx.execute(token, tool, args),
    log: () => {},
  });
});

afterAll(async () => {
  await running.close();
});

async function connect(runToken: string, bearer = running.token): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(running.urlForRun(runToken)), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return client;
}

describe('Ripple MCP server', () => {
  it('binds to loopback and serves runs under /mcp/<token>', () => {
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(running.urlForRun('abcdefgh12')).toBe(`${running.url}/abcdefgh12`);
  });

  it('rejects a wrong bearer token', async () => {
    await expect(connect(tx.beginRun().token, 'wrong')).rejects.toThrow();
  });

  it('lists the tools with read and write annotations and no epoch argument', async () => {
    const client = await connect(tx.beginRun().token);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['propose_write', 'read_file', 'replace_selection']);
    expect(byName.read_file?.annotations?.readOnlyHint).toBe(true);
    expect(byName.propose_write?.annotations?.readOnlyHint).toBe(false);
    expect(Object.keys(byName.propose_write?.inputSchema.properties ?? {})).toEqual(['path', 'edits']);
    await client.close();
  });

  it('read_file returns numbered lines', async () => {
    const client = await connect(tx.beginRun().token);
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'README.md' } });
    expect(result.content).toEqual([{ type: 'text', text: '1  # Title\n2  line two' }]);
    await client.close();
  });

  it('a stale run token is rejected and changes nothing', async () => {
    const run = tx.beginRun();
    tx.endRun(run.id, 'cancelled');
    const client = await connect(run.token);
    const read = await client.callTool({ name: 'read_file', arguments: { path: 'README.md' } });
    expect(read.isError).toBe(true);
    const write = await client.callTool({
      name: 'propose_write',
      arguments: { path: 'README.md', edits: [{ old_text: 'line two', new_text: 'line 2' }] },
    });
    expect(write.isError).toBe(true);
    expect(JSON.stringify(write.content)).toMatch(/cancelled.*Nothing was changed/);
    expect(files['README.md']).toBe('# Title\nline two');
    await client.close();
  });

  it('propose_write applies only after review and says "applied"', async () => {
    const client = await connect(tx.beginRun().token);
    const result = await client.callTool({
      name: 'propose_write',
      arguments: { path: 'README.md', edits: [{ old_text: 'line two', new_text: 'line 2' }] },
    });
    expect(JSON.stringify(result.content)).toMatch(/: applied/);
    expect(files['README.md']).toBe('# Title\nline 2');
    await client.close();
  });
});
