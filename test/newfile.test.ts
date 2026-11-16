import { describe, expect, it } from 'vitest';
import { TransactionManager, type EditorHost, type FileChange, type Proposal } from '../src/core/transactions';

type Reviewer = (p: Proposal, tx: TransactionManager) => void;
const acceptAll: Reviewer = (p, tx) => p.hunks.forEach((h) => tx.decide(p.id, h.id, true));

/** In-memory editor that can create and delete files as part of one multi-file edit. */
function setup(files: Record<string, string>, reviewer: Reviewer = acceptAll) {
  const batches: FileChange[][] = [];
  const reviews: Proposal[] = [];
  let tx!: TransactionManager;
  const apply = (base: string, c: FileChange): string => {
    let text = base;
    for (const e of [...c.edits].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    return text;
  };
  const host: EditorHost = {
    readText: async (p) => {
      if (p.startsWith('..')) throw new Error(`path is outside the workspace: ${p}`);
      const t = files[p];
      if (t === undefined) throw new Error(`no such file ${p}`);
      return t;
    },
    applyEdits: async () => 'changed',
    applyAll: async (changes) => {
      for (const c of changes) {
        if (c.create ? files[c.path] !== undefined : files[c.path] !== c.baseText) return { changed: c.path };
      }
      for (const c of changes) {
        if (c.remove) delete files[c.path];
        else files[c.path] = apply(c.create ? '' : c.baseText, c);
      }
      batches.push(changes);
      return 'ok';
    },
    review: async (p) => {
      reviews.push(p);
      reviewer(p, tx);
    },
  };
  tx = new TransactionManager(host);
  return { tx, files, batches, reviews };
}

const create = (path: string, text: string) => ({ path, edits: [{ old_text: '', new_text: text }] });
const TEST_FILE = 'def test_config():\n    assert True\n';

describe('propose_write creating a new file', () => {
  it('stages the file for review, shows it to read_file, and writes nothing until commit', async () => {
    const { tx, files, reviews, batches } = setup({ 'a.py': 'alpha\n' });
    const run = tx.beginRun(undefined, { deferred: true });
    const out = await tx.execute(run.token, 'propose_write', create('tests/test_new.py', TEST_FILE));
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/New file tests\/test_new\.py is staged .* does not exist on disk yet/);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ creates: true, baseText: '', path: 'tests/test_new.py' });
    expect(reviews[0]!.hunks).toHaveLength(1);
    expect(reviews[0]!.hunks[0]!.newLines).toEqual(['def test_config():', '    assert True']);
    expect(files['tests/test_new.py']).toBeUndefined();
    expect(batches).toEqual([]);
    expect(await tx.readForRun(run.token, 'tests/test_new.py')).toBe(TEST_FILE);
  });

  it('creates it together with edits to other files in ONE edit, and records it for undo', async () => {
    const { tx, files, batches } = setup({ 'a.py': 'alpha\nbeta\n' });
    const run = tx.beginRun(undefined, { deferred: true });
    await tx.execute(run.token, 'propose_write', { path: 'a.py', edits: [{ old_text: 'beta', new_text: 'BETA' }] });
    await tx.execute(run.token, 'propose_write', create('docs/new.rst', 'Title\n=====\n'));
    const commit = await tx.commit(run.id);
    expect(commit).toMatchObject({ ok: true, hunks: 2, files: ['a.py', 'docs/new.rst'] });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((c) => [c.path, Boolean(c.create)])).toEqual([['a.py', false], ['docs/new.rst', true]]);
    expect(files).toEqual({ 'a.py': 'alpha\nBETA\n', 'docs/new.rst': 'Title\n=====\n' });
    expect(tx.lastApplied?.files).toEqual([
      { path: 'a.py', before: 'alpha\nbeta\n', after: 'alpha\nBETA\n' },
      { path: 'docs/new.rst', before: '', after: 'Title\n=====\n', created: true },
    ]);
  });

  it('adds the final newline and strips a Markdown fence', async () => {
    const { tx, files } = setup({});
    const run = tx.beginRun(undefined, { deferred: true });
    await tx.execute(run.token, 'propose_write', create('x.py', '```python\nprint(1)\n```'));
    await tx.commit(run.id);
    expect(files['x.py']).toBe('print(1)\n');
  });

  it('a later edit in the same run builds on the staged new file', async () => {
    const { tx, files } = setup({});
    const run = tx.beginRun(undefined, { deferred: true });
    await tx.execute(run.token, 'propose_write', create('x.py', 'one\ntwo\n'));
    const second = await tx.execute(run.token, 'propose_write', { path: 'x.py', edits: [{ old_text: 'two', new_text: 'TWO' }] });
    expect(second.isError).toBe(false);
    await tx.commit(run.id);
    expect(files['x.py']).toBe('one\nTWO\n');
    expect(tx.lastApplied?.files).toEqual([{ path: 'x.py', before: '', after: 'one\nTWO\n', created: true }]);
  });

  it('rejecting the review creates nothing and tells the agent why', async () => {
    const { tx, files, batches } = setup({}, (p, t) => p.hunks.forEach((h) => t.decide(p.id, h.id, false, 'put it in the existing test file')));
    const run = tx.beginRun(undefined, { deferred: true });
    const out = await tx.execute(run.token, 'propose_write', create('tests/test_new.py', TEST_FILE));
    expect(out.text).toMatch(/rejected by user: put it in the existing test file/);
    await tx.commit(run.id);
    expect(files).toEqual({});
    expect(batches).toEqual([]);
  });

  it('cancel before commit leaves no file; failure after commit deletes the created file again', async () => {
    const a = setup({});
    const run1 = a.tx.beginRun(undefined, { deferred: true });
    await a.tx.execute(run1.token, 'propose_write', create('new.py', 'x = 1\n'));
    a.tx.endRun(run1.id, 'cancelled');
    expect(await a.tx.rollback(run1.id)).toEqual([]);
    expect(a.files).toEqual({});

    const b = setup({ 'a.py': 'alpha\n' });
    const run2 = b.tx.beginRun(undefined, { deferred: true });
    await b.tx.execute(run2.token, 'propose_write', create('new.py', 'x = 1\n'));
    await b.tx.execute(run2.token, 'propose_write', { path: 'a.py', edits: [{ old_text: 'alpha', new_text: 'ALPHA' }] });
    await b.tx.commit(run2.id);
    expect(Object.keys(b.files).sort()).toEqual(['a.py', 'new.py']);
    b.tx.endRun(run2.id, 'failed');
    expect((await b.tx.rollback(run2.id)).sort()).toEqual(['a.py', 'new.py']);
    expect(b.files).toEqual({ 'a.py': 'alpha\n' });
    expect(b.batches[1]!.find((c) => c.path === 'new.py')).toMatchObject({ remove: true });
    expect(b.tx.lastApplied).toBeUndefined();
  });

  it('does not overwrite a file that appeared after staging', async () => {
    const { tx, files } = setup({});
    const run = tx.beginRun(undefined, { deferred: true });
    await tx.execute(run.token, 'propose_write', create('new.py', 'x = 1\n'));
    files['new.py'] = 'made by the user\n';
    const commit = await tx.commit(run.id);
    expect(commit.ok).toBe(false);
    expect(commit.error).toMatch(/new\.py changed outside Ripple/);
    expect(files['new.py']).toBe('made by the user\n');
  });

  it('explains how to create a file when the call is not a creation, and refuses paths outside the workspace', async () => {
    const { tx, files } = setup({});
    const run = tx.beginRun(undefined, { deferred: true });
    const edit = await tx.execute(run.token, 'propose_write', { path: 'missing.py', edits: [{ old_text: 'a', new_text: 'b' }] });
    expect(edit.isError).toBe(true);
    expect(edit.text).toMatch(/missing\.py does not exist\. To create it, call propose_write with exactly one edit whose old_text is ""/);
    const outside = await tx.execute(run.token, 'propose_write', create('../evil.py', 'x\n'));
    expect(outside.isError).toBe(true);
    expect(outside.text).toMatch(/outside the workspace/);
    const empty = await tx.execute(run.token, 'propose_write', create('blank.py', '   '));
    expect(empty.isError).toBe(true);
    expect(files).toEqual({});
  });

  it('an existing file still refuses an empty old_text', async () => {
    const { tx, files } = setup({ 'a.py': 'alpha\n' });
    const run = tx.beginRun(undefined, { deferred: true });
    const out = await tx.execute(run.token, 'propose_write', create('a.py', 'replaced\n'));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/old_text is empty/);
    expect(files['a.py']).toBe('alpha\n');
  });

  it('works in a run that applies at once (not deferred)', async () => {
    const { tx, files } = setup({});
    const run = tx.beginRun();
    const out = await tx.execute(run.token, 'propose_write', create('new.py', 'x = 1\n'));
    expect(out.isError).toBe(false);
    expect(files['new.py']).toBe('x = 1\n');
    expect(tx.lastApplied?.files).toEqual([{ path: 'new.py', before: '', after: 'x = 1\n', created: true }]);
  });
});
