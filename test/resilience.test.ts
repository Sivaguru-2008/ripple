import { describe, expect, it, vi } from 'vitest';
import { TransactionManager } from '../src/core/transactions';
import type { TrueForgeClient } from '../src/trueforge/client';
import { Runner, type RunnerDeps, type RunRequest } from '../src/trueforge/runner';

function createFixture(initialFiles: Record<string, string> = { 'test.txt': 'original content' }) {
  const disk = { ...initialFiles };
  const logs: string[] = [];

  const tx = new TransactionManager({
    readText: async (p) => {
      const t = disk[p];
      if (t === undefined) throw new Error(`file not found: ${p}`);
      return t;
    },
    applyEdits: async (p, base, edits) => {
      if (disk[p] !== base) return 'changed';
      let t = base;
      for (const e of [...edits].sort((a, b) => b.start - a.start)) {
        t = t.slice(0, e.start) + e.text + t.slice(e.end);
      }
      disk[p] = t;
      return 'ok';
    },
    review: async (proposal) => {
      // Auto-accept hunks for testing
      for (const h of proposal.hunks) {
        tx.decide(proposal.id, h.id, true);
      }
    },
  });

  const sessionIds: string[] = [];
  let sessionCounter = 0;

  const mockTf = {
    registerMcpServer: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockImplementation(async (spec: { model: { name: string } }) => {
      const id = `session-${++sessionCounter}-${spec.model.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      sessionIds.push(id);
      return id;
    }),
    runTurn: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
  };

  const runner = new Runner({
    tx,
    tf: mockTf as unknown as TrueForgeClient,
    mcpUrlForRun: (token) => `http://127.0.0.1:8790/mcp/${token}`,
    mcpBearer: 'test-bearer',
    log: (line) => logs.push(line),
  });

  const primarySpec = {
    model: { name: 'primary/bad-endpoint' },
    instructions: 'Test instructions',
  };

  const fallbackSpec = {
    model: { name: 'fallback/qwen-7b' },
    instructions: 'Test instructions',
  };

  return {
    disk,
    tx,
    mockTf,
    runner,
    logs,
    primarySpec,
    fallbackSpec,
    sessionIds,
  };
}

describe('Task C Resilience & Model Fallback', () => {
  it('detects primary model timeout and recovers on secondary fallback model', async () => {
    const { runner, mockTf, primarySpec, fallbackSpec, tx, disk, logs } = createFixture();

    let attempt = 0;
    mockTf.runTurn.mockImplementation(async (_sessionId: string, _message: string, handlers: any) => {
      attempt++;
      if (attempt === 1) {
        // Primary model times out with headers timeout
        return { status: 'error', message: '[Model Error] Headers Timeout Error after 60s' };
      }
      // Fallback model succeeds
      return { status: 'done' };
    });

    const fallbackCalls: Array<{ from: string; to: string; reason: string }> = [];
    const result = await runner.run({
      spec: primarySpec,
      fallbackSpec,
      message: 'Do Task A',
      decideOther: async () => ({ allow: true }),
      onFallback: (from, to, reason) => fallbackCalls.push({ from, to, reason }),
      attempts: 1, // trigger fallback on 1 failure
    });

    expect(result.status).toBe('done');
    expect(fallbackCalls.length).toBe(1);
    expect(fallbackCalls[0]!.from).toBe('primary/bad-endpoint');
    expect(fallbackCalls[0]!.to).toBe('fallback/qwen-7b');
    expect(fallbackCalls[0]!.reason).toContain('Headers Timeout Error');

    // Preserved the same run identity
    expect(result.runIds.length).toBe(1);
    expect(tx.getRun(result.runIds[0]!)?.state).toBe('finished');
    expect(disk['test.txt']).toBe('original content');

    // The fallback wrote nothing: the result must say so instead of looking like a success.
    expect(result.model).toBe('fallback/qwen-7b');
    expect(result.hunksWritten).toBe(0);
    expect(result.fallback).toEqual({
      from: 'primary/bad-endpoint',
      to: 'fallback/qwen-7b',
      reason: '[Model Error] Headers Timeout Error after 60s',
    });
    expect(result.message).toContain('primary/bad-endpoint failed');
    expect(result.message).toContain('finished without changing any file');
    expect(logs.some((l) => l.includes('done with a warning'))).toBe(true);
  });

  it('reports a run that ends without edits and without fallback', async () => {
    const { runner, mockTf, primarySpec, fallbackSpec } = createFixture();
    mockTf.runTurn.mockResolvedValue({ status: 'done' });

    const result = await runner.run({
      spec: primarySpec,
      fallbackSpec,
      message: 'Do nothing',
      decideOther: async () => ({ allow: true }),
    });

    expect(result.status).toBe('done');
    expect(result.model).toBe('primary/bad-endpoint');
    expect(result.fallback).toBeUndefined();
    expect(result.hunksWritten).toBe(0);
    expect(result.message).toBe('The run finished without changing any file.');
  });

  it('names the fallback model in the error when both models fail', async () => {
    const { runner, mockTf, primarySpec, fallbackSpec } = createFixture();
    mockTf.runTurn.mockResolvedValue({ status: 'error', message: 'Cannot connect to API: bad port' });

    const result = await runner.run({
      spec: primarySpec,
      fallbackSpec,
      message: 'Both fail',
      decideOther: async () => ({ allow: true }),
      attempts: 1,
    });

    expect(result.status).toBe('error');
    expect(result.model).toBe('fallback/qwen-7b');
    expect(result.fallback?.from).toBe('primary/bad-endpoint');
    expect(result.message).toContain('fallback model fallback/qwen-7b');
  });

  it('detects primary model connection failure (bad port / ECONNREFUSED) and recovers on fallback', async () => {
    const { runner, mockTf, primarySpec, fallbackSpec, tx, logs } = createFixture();

    let attempt = 0;
    mockTf.runTurn.mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        return { status: 'error', message: '[Model Error] Cannot connect to API: bad port' };
      }
      return { status: 'done' };
    });

    const fallbackEvents: string[] = [];
    const result = await runner.run({
      spec: primarySpec,
      fallbackSpec,
      message: 'Test connection failure',
      decideOther: async () => ({ allow: true }),
      onFallback: (from, to) => fallbackEvents.push(`${from}->${to}`),
      attempts: 1,
    });

    expect(result.status).toBe('done');
    expect(fallbackEvents).toEqual(['primary/bad-endpoint->fallback/qwen-7b']);
    expect(result.runIds.length).toBe(1);
    expect(tx.getRun(result.runIds[0]!)?.state).toBe('finished');
  });

  it('handles invalid tool-call response and recovers cleanly without applying stale edits', async () => {
    const { runner, mockTf, primarySpec, fallbackSpec, tx } = createFixture();

    let attempt = 0;
    mockTf.runTurn.mockImplementation(async (_sessionId: string, _msg: string, handlers: any) => {
      attempt++;
      const run = tx.activeRun();
      if (attempt === 1 && run) {
        // Stage a proposal that will fail due to malformed tool call
        await tx.execute(run.token, 'propose_write', {
          epoch: 0,
          path: 'test.txt',
          edits: [{ old_text: 'original content', new_text: 'stale corrupt edit' }],
        });
        return { status: 'error', message: 'invalid tool-call response: malformed tool arguments' };
      }
      // Fallback model runs cleanly
      return { status: 'done' };
    });

    const result = await runner.run({
      spec: primarySpec,
      fallbackSpec,
      message: 'Test invalid tool response',
      deferred: true,
      decideOther: async () => ({ allow: true }),
      attempts: 1,
    });

    expect(result.status).toBe('done');
    // Stale proposal from attempt 1 must be marked discarded/failed
    const runId = result.runIds[0]!;
    const proposals = tx.proposalsFor(runId);
    expect(proposals.some((p) => p.state === 'discarded')).toBe(true);
    expect(tx.stagedText(runId, 'test.txt')).toBe('original content');
  });

  it('fails cleanly and preserves workspace unchanged when secondary fallback model also fails', async () => {
    const { runner, mockTf, primarySpec, fallbackSpec, tx, disk } = createFixture();

    mockTf.runTurn.mockImplementation(async () => {
      return { status: 'error', message: 'Cannot connect to API: all providers down' };
    });

    const result = await runner.run({
      spec: primarySpec,
      fallbackSpec,
      message: 'Test total failure',
      decideOther: async () => ({ allow: true }),
      attempts: 1,
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('Cannot connect to API');
    expect(tx.getRun(result.runIds[0]!)?.state).toBe('failed');
    // Workspace files on disk must remain strictly unchanged
    expect(disk['test.txt']).toBe('original content');
  });

  it('cancels safely during fallback switching and leaves workspace clean', async () => {
    const { runner, mockTf, primarySpec, fallbackSpec, tx, disk } = createFixture();

    mockTf.runTurn.mockImplementation(async () => {
      // User cancels while fallback is triggered
      void runner.cancel();
      return { status: 'error', message: 'connection failure' };
    });

    const result = await runner.run({
      spec: primarySpec,
      fallbackSpec,
      message: 'Test cancellation during fallback',
      decideOther: async () => ({ allow: true }),
      attempts: 1,
    });

    expect(result.status).toBe('cancelled');
    expect(tx.getRun(result.runIds[0]!)?.state).toBe('cancelled');
    expect(disk['test.txt']).toBe('original content');
  });

  it('performs successful end-to-end recovery preserving transaction identity', async () => {
    const { runner, mockTf, primarySpec, fallbackSpec, tx, disk, logs } = createFixture();

    let attempt = 0;
    mockTf.runTurn.mockImplementation(async (_sessionId: string, _msg: string, handlers: any) => {
      attempt++;
      const run = tx.activeRun();
      if (attempt === 1) {
        return { status: 'error', message: '503 Service Unavailable' };
      }
      // Successful fallback propose_write
      if (run) {
        await tx.execute(run.token, 'propose_write', {
          epoch: 0,
          path: 'test.txt',
          edits: [{ old_text: 'original content', new_text: 'recovered and verified content' }],
        });
      }
      return { status: 'done' };
    });

    const result = await runner.run({
      spec: primarySpec,
      fallbackSpec,
      message: 'Recover successfully',
      deferred: true,
      decideOther: async () => ({ allow: true }),
      attempts: 1,
    });

    console.log('Test 6 Result:', result, 'Logs:', logs);
    expect(result.status).toBe('done');
    expect(result.runIds.length).toBe(1);
    const runId = result.runIds[0]!;
    expect(tx.getRun(runId)?.state).toBe('finished');
    // Successful edit applied on disk
    expect(disk['test.txt']).toBe('recovered and verified content');
    // Edits from the fallback model are flagged for review, not passed off as the primary's.
    expect(result.hunksWritten).toBe(1);
    expect(result.fallback?.to).toBe('fallback/qwen-7b');
    expect(result.message).toContain('wrote 1 change(s)');
  });
});
