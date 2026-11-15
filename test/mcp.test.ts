import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, type RunningMcpServer, type WriteProposal } from '../src/mcp/server';

const files: Record<string, string> = { 'README.md': '# Title\nline two' };
const proposals: WriteProposal[] = [];
let running: RunningMcpServer;

beforeAll(async () => {
  running = await startMcpServer({
    readText: async (p) => {
      const text = files[p];
      if (text === undefined) throw new Error(`no such file: ${p}`);
      return text;
    },
    onProposal: (p) => proposals.push(p),
    log: () => {},
  });
});

afterAll(async () => {
  await running.close();
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(running.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe('Ripple MCP server', () => {
  it('binds to loopback', () => {
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('rejects a wrong bearer token', async () => {
    await expect(connect('wrong')).rejects.toThrow();
  });

  it('lists two tools with read and write annotations', async () => {
    const client = await connect(running.token);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['propose_write', 'read_file']);
    expect(byName.read_file?.annotations?.readOnlyHint).toBe(true);
    expect(byName.propose_write?.annotations?.readOnlyHint).toBe(false);
    expect(byName.propose_write?.annotations?.destructiveHint).toBe(false);
    await client.close();
  });

  it('read_file returns numbered lines', async () => {
    const client = await connect(running.token);
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'README.md' } });
    expect(result.content).toEqual([{ type: 'text', text: '1  # Title\n2  line two' }]);
    await client.close();
  });

  it('propose_write only records the proposal', async () => {
    const client = await connect(running.token);
    const edits = [{ start_line: 3, end_line: 2, new_text: 'line three' }];
    const result = await client.callTool({
      name: 'propose_write',
      arguments: { epoch: 0, path: 'README.md', edits },
    });
    expect(JSON.stringify(result.content)).toContain('staged');
    expect(proposals).toEqual([{ epoch: 0, path: 'README.md', edits }]);
    expect(files['README.md']).toBe('# Title\nline two');
    await client.close();
  });
});
