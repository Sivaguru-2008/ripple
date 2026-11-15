import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAgentSpec } from '../src/trueforge/client';

describe('agents/ripple-agent.json', () => {
  const raw: unknown = JSON.parse(readFileSync('agents/ripple-agent.json', 'utf-8'));

  it('parses as a TrueForge agent spec', () => {
    const spec = parseAgentSpec(raw);
    expect(spec.model.name).toMatch(/^[^/]+\/.+$/);
    const ripple = spec.mcpServers?.find((s) => s.name === 'ripple');
    expect(ripple?.requireApprovalForTools).toContain('propose_write');
    expect(ripple?.enableTools).toEqual(['read_file', 'propose_write']);
  });

  it('rejects a spec without a model', () => {
    expect(() => parseAgentSpec({ instructions: 'x' })).toThrow(/invalid agent definition/);
  });
});
