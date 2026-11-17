import { describe, expect, it } from 'vitest';
import { TransactionManager } from '../src/core/transactions';

function fixture(decide: (hunk: number) => boolean | string = () => true) {
  const disk: Record<string, string> = {
    'src/cli.py': 'import click\n\ndef routes():\n    pass\n',
    'docs/cli.rst': 'CLI\n===\n\nText.\n',
  };
  const tx: TransactionManager = new TransactionManager({
    readText: async (p) => {
      const t = disk[p];
      if (t === undefined) throw new Error(`no ${p}`);
      return t;
    },
    applyEdits: async (p, base, edits) => {
      if (disk[p] !== base) return 'changed';
      let t = base;
      for (const e of [...edits].sort((a, b) => b.start - a.start)) t = t.slice(0, e.start) + e.text + t.slice(e.end);
      disk[p] = t;
      return 'ok';
    },
    review: async (proposal) => {
      proposal.hunks.forEach((h, k) => {
        const answer = decide(k);
        if (answer === true) tx.decide(proposal.id, h.id, true);
        else tx.decide(proposal.id, h.id, false, typeof answer === 'string' ? answer : undefined);
      });
    },
  });
  return { tx, disk };
}

describe('progressSummary', () => {
  it('is empty before any change', () => {
    const { tx } = fixture();
    const run = tx.beginRun(undefined, { deferred: true });
    expect(tx.progressSummary(run.id)).toBeUndefined();
  });

  it('lists accepted changes per file, with their first line, so an agent does not redo them', async () => {
    const { tx } = fixture();
    const run = tx.beginRun(undefined, { deferred: true });
    await tx.execute(run.token, 'propose_write', {
      path: 'src/cli.py',
      edits: [{ insert_after_line: 4, line_text: '    pass', new_text: '\n\ndef config_command():\n    pass' }],
    });
    await tx.execute(run.token, 'propose_write', { path: 'docs/cli.rst', edits: [{ old_text: 'Text.', new_text: 'Text.\n\nConfig\n------' }] });
    const summary = tx.progressSummary(run.id) ?? '';
    expect(summary).toMatch(/Do not make them again/);
    expect(summary).toMatch(/- src\/cli\.py: done, insert before line \d+: def config_command\(\):/);
    expect(summary).toMatch(/- docs\/cli\.rst: done, /);
  });

  it('reports rejected hunks with the reason', async () => {
    const { tx } = fixture(() => 'not this file');
    const run = tx.beginRun(undefined, { deferred: true });
    await tx.execute(run.token, 'propose_write', { path: 'docs/cli.rst', edits: [{ old_text: 'Text.', new_text: 'Other.' }] });
    expect(tx.progressSummary(run.id)).toMatch(/docs\/cli\.rst: rejected by the user \(not this file\), /);
  });
});
