import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAgentSpec } from '../src/trueforge/client';
import { writeToolName } from '../src/trueforge/runner';

const load = (name: string): unknown => JSON.parse(readFileSync(`agents/${name}`, 'utf-8'));

describe('agents/ripple-agent.json', () => {
  it('parses as a TrueForge agent spec', () => {
    const spec = parseAgentSpec(load('ripple-agent.json'));
    expect(spec.model.name).toMatch(/^[^/]+\/.+$/);
    const ripple = spec.mcpServers?.find((s) => s.name === 'ripple');
    expect(ripple?.requireApprovalForTools).toEqual(['propose_write', 'run_command']);
    expect(ripple?.enableTools).toEqual([
      'read_file',
      'search_workspace',
      'retrieve_context',
      'propose_write',
      'run_command',
    ]);
    expect(ripple?.preloadTools).toEqual([
      'read_file',
      'search_workspace',
      'retrieve_context',
      'propose_write',
      'run_command',
    ]);
    // Every tool up front: no list_tools / call_tool steps, each of which resends the whole history.
    expect(ripple?.preload).toBe(true);
    // Compaction is the TrueForge context-engineering feature this agent relies on: a Task B run
    // passes 12,000 input tokens after about ten steps, and older steps are then summarised.
    expect(spec.config?.contextManagement?.compaction).toEqual({ enabled: true, trigger: { type: 'input_tokens', value: 12000 } });
    expect(spec.instructions).not.toMatch(/epoch/);
    expect(spec.instructions).toMatch(/retrieve_context/);
    expect(spec.instructions).toMatch(/run_command/);
  });

  it('rejects a spec without a model', () => {
    expect(() => parseAgentSpec({ instructions: 'x' })).toThrow(/invalid agent definition/);
  });
});

describe('agents/ripple-inline.json', () => {
  it('exposes only replace_selection, approval-gated', () => {
    const spec = parseAgentSpec(load('ripple-inline.json'));
    const ripple = spec.mcpServers?.find((s) => s.name === 'ripple');
    expect(ripple?.enableTools).toEqual(['replace_selection']);
    expect(ripple?.requireApprovalForTools).toEqual(['replace_selection']);
  });
});

describe('writeToolName', () => {
  it('recognises prefixed write tools only', () => {
    expect(writeToolName('propose_write')).toBe('propose_write');
    expect(writeToolName('ripple__replace_selection')).toBe('replace_selection');
    expect(writeToolName('read_file')).toBeUndefined();
  });
});
