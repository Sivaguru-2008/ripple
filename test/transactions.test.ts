import { describe, expect, it, vi } from 'vitest';
import { diffLines, stripLineGutter } from '../src/core/diff';
import { applyTextEdits, TransactionManager, type EditorHost, type Proposal, type TextReplacement } from '../src/core/transactions';

const BASE = [
  'def get_debug_flag() -> bool:',
  '    """Get whether debug mode should be enabled."""',
  '    val = os.environ.get("FLASK_DEBUG")',
  '    return bool(val and val.lower() not in {"0", "false", "no"})',
  '',
].join('\n');

type Reviewer = (p: Proposal, tx: TransactionManager) => void | Promise<void>;

/** In-memory editor: files, a count of edits applied, and a scripted reviewer. */
function setup(files: Record<string, string>, reviewer: Reviewer = () => {}) {
  const applied: { path: string; edits: TextReplacement[] }[] = [];
  const reviews: Proposal[] = [];
  let tx!: TransactionManager;
  const host: EditorHost = {
    readText: async (p) => {
      const t = files[p];
      if (t === undefined) throw new Error(`no such file ${p}`);
      return t;
    },
    applyEdits: async (p, baseText, edits) => {
      if (files[p] !== baseText) return 'changed';
      let text = baseText;
      for (const e of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
      files[p] = text;
      applied.push({ path: p, edits });
      return 'ok';
    },
    review: async (p) => {
      reviews.push(p);
      await reviewer(p, tx);
    },
  };
  tx = new TransactionManager(host);
  return { tx, files, applied, reviews };
}

const acceptAll: Reviewer = (p, tx) => p.hunks.forEach((h) => tx.decide(p.id, h.id, true));

/** Edit touching two separate places, so it yields two hunks. */
const twoHunkEdit = {
  path: 'helpers.py',
  edits: [
    { old_text: 'enabled."""', new_text: 'enabled.\n\n    Off values: 0, false, no, off, n."""' },
    { old_text: '{"0", "false", "no"}', new_text: '{"0", "false", "no", "off", "n"}' },
  ],
};

describe('runs', () => {
  it('rejects calls from an unknown, finished or cancelled run and changes nothing', async () => {
    const { tx, files, applied } = setup({ 'helpers.py': BASE }, acceptAll);
    expect((await tx.execute('nope', 'propose_write', twoHunkEdit)).text).toMatch(/does not belong to any Ripple run/);

    const done = tx.beginRun();
    tx.endRun(done.id, 'finished');
    const r1 = await tx.execute(done.token, 'propose_write', twoHunkEdit);
    expect(r1.isError).toBe(true);
    expect(r1.text).toMatch(/run-1 is finished.*Nothing was changed/);

    const cancelled = tx.beginRun();
    tx.endRun(cancelled.id, 'cancelled');
    expect((await tx.execute(cancelled.token, 'propose_write', twoHunkEdit)).text).toMatch(/is cancelled/);

    expect(applied).toEqual([]);
    expect(files['helpers.py']).toBe(BASE);
  });

  it('issues a different token per run', () => {
    const { tx } = setup({});
    const a = tx.beginRun();
    const b = tx.beginRun();
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
  });
});

describe('staging and review', () => {
  it('splits an edit into hunks and applies all accepted hunks as one edit', async () => {
    const { tx, files, applied } = setup({ 'helpers.py': BASE }, acceptAll);
    const run = tx.beginRun();
    const answer = await tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit);
    expect(answer).toEqual({ allow: true });
    const out = await tx.execute(run.token, 'propose_write', twoHunkEdit);
    expect(out.isError).toBe(false);
    expect(out.text.match(/: applied/g)).toHaveLength(2);
    expect(applied).toHaveLength(1); // one WorkspaceEdit → one undo step
    expect(applied[0]?.edits).toHaveLength(2);
    expect(files['helpers.py']).toContain('"off", "n"');
    expect(files['helpers.py']).toContain('Off values');
    expect(tx.lastApplied?.files[0]?.before).toBe(BASE);
    expect(tx.lastApplied?.files[0]?.after).toBe(files['helpers.py']);
  });

  it('partial accept writes only the accepted hunk and reports the rejection reason', async () => {
    const { tx, files } = setup({ 'helpers.py': BASE }, (p, t) => {
      t.decide(p.id, p.hunks[0]!.id, false, 'keep the docstring short');
      t.decide(p.id, p.hunks[1]!.id, true);
    });
    const run = tx.beginRun();
    expect(await tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit)).toEqual({ allow: true });
    const out = await tx.execute(run.token, 'propose_write', twoHunkEdit);
    expect(out.text).toMatch(/rejected by user: keep the docstring short/);
    expect(out.text).toMatch(/: applied/);
    expect(out.text).toMatch(/1 of 2 hunk\(s\) were written/);
    expect(files['helpers.py']).toContain('"off", "n"');
    expect(files['helpers.py']).not.toContain('Off values');
  });

  it('rejecting every hunk denies the approval with the reasons and writes nothing', async () => {
    const { tx, files, applied } = setup({ 'helpers.py': BASE }, (p, t) =>
      p.hunks.forEach((h) => t.decide(p.id, h.id, false, 'wrong approach')),
    );
    const run = tx.beginRun();
    const answer = await tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit);
    expect(answer.allow).toBe(false);
    expect(!answer.allow && answer.reason).toMatch(/rejected by user: wrong approach.*Nothing was written/);
    expect(applied).toEqual([]);
    expect(files['helpers.py']).toBe(BASE);
  });

  it('a duplicate call after apply is reported, not staged again', async () => {
    const { tx, applied, reviews } = setup({ 'helpers.py': BASE }, acceptAll);
    const run = tx.beginRun();
    await tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit);
    await tx.execute(run.token, 'propose_write', twoHunkEdit);
    // The model repeats the same call.
    expect(await tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit)).toEqual({ allow: true });
    const again = await tx.execute(run.token, 'propose_write', twoHunkEdit);
    expect(again.text).toMatch(/^already applied/);
    expect(applied).toHaveLength(1);
    expect(reviews).toHaveLength(1);
    expect(tx.proposalsFor(run.id)).toHaveLength(1);
  });

  it('a duplicate while the first is under review says "already staged, awaiting review"', async () => {
    let release!: () => void;
    const { tx, reviews } = setup({ 'helpers.py': BASE }, () => new Promise<void>((r) => (release = r)));
    const run = tx.beginRun();
    const first = tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit);
    await vi.waitFor(() => expect(reviews).toHaveLength(1));
    const dup = await tx.execute(run.token, 'propose_write', twoHunkEdit);
    expect(dup.text).toMatch(/^already staged, awaiting review/);
    tx.endRun(run.id, 'cancelled');
    release();
    expect((await first).allow).toBe(false);
  });

  it('same hunks proposed with different argument formatting count as a duplicate', async () => {
    const { tx, reviews } = setup({ 'helpers.py': BASE }, acceptAll);
    const run = tx.beginRun();
    await tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit);
    const reordered = { path: 'helpers.py', edits: [twoHunkEdit.edits[1]!, twoHunkEdit.edits[0]!] };
    expect(await tx.reviewForApproval(run.id, 'propose_write', reordered)).toEqual({ allow: true });
    expect(reviews).toHaveLength(1);
  });

  it('hunk ids depend on base text, range and new text only', async () => {
    const a = setup({ 'helpers.py': BASE }, acceptAll);
    const b = setup({ 'helpers.py': BASE }, acceptAll);
    await a.tx.reviewForApproval(a.tx.beginRun().id, 'propose_write', twoHunkEdit);
    await b.tx.reviewForApproval(b.tx.beginRun().id, 'propose_write', twoHunkEdit);
    expect(a.reviews[0]!.hunks.map((h) => h.id)).toEqual(b.reviews[0]!.hunks.map((h) => h.id));
  });

  it('fails cleanly if the file changed between staging and apply', async () => {
    const files = { 'helpers.py': BASE };
    const { tx, applied } = setup(files, (p, t) => {
      acceptAll(p, t);
      files['helpers.py'] = BASE.replace('debug', 'DEBUG'); // user typed during review
    });
    const run = tx.beginRun();
    await tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit);
    const out = await tx.execute(run.token, 'propose_write', twoHunkEdit);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/not applied: the file changed after the edit was staged/);
    expect(out.text).toMatch(/Nothing was written/);
    expect(applied).toEqual([]);
  });

  it('cancel mid-run discards staged hunks, ends the review and rejects later calls', async () => {
    const { tx, files, applied, reviews } = setup({ 'helpers.py': BASE }, () => new Promise<void>(() => {}));
    const run = tx.beginRun();
    const pending = tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit);
    await vi.waitFor(() => expect(reviews).toHaveLength(1));
    tx.endRun(run.id, 'cancelled');
    const answer = await pending;
    expect(answer.allow).toBe(false);
    expect(tx.proposalsFor(run.id).every((p) => p.state === 'discarded')).toBe(true);
    const late = await tx.execute(run.token, 'propose_write', twoHunkEdit);
    expect(late.isError).toBe(true);
    expect(late.text).toMatch(/cancelled/);
    expect(applied).toEqual([]);
    expect(files['helpers.py']).toBe(BASE);
  });

  it('a review closed early counts undecided hunks as rejected', async () => {
    const { tx, files } = setup({ 'helpers.py': BASE }, (p, t) => t.decide(p.id, p.hunks[1]!.id, true));
    const run = tx.beginRun();
    expect(await tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit)).toEqual({ allow: true });
    const out = await tx.execute(run.token, 'propose_write', twoHunkEdit);
    expect(out.text).toMatch(/rejected by user: review closed without a decision/);
    expect(files['helpers.py']).not.toContain('Off values');
    expect(files['helpers.py']).toContain('"off", "n"');
  });
});

describe('concurrency', () => {
  it('two identical calls arriving together stage once', async () => {
    const { tx, reviews } = setup({ 'helpers.py': BASE }, acceptAll);
    const run = tx.beginRun();
    const [a, b] = await Promise.all([
      tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit),
      tx.reviewForApproval(run.id, 'propose_write', twoHunkEdit),
    ]);
    expect(a).toEqual({ allow: true });
    expect(b).toEqual({ allow: true });
    expect(reviews).toHaveLength(1);
  });
});

describe('propose_write arguments', () => {
  it('rejects old_text that is missing or ambiguous, and says why', async () => {
    const { tx, files } = setup({ 'helpers.py': BASE, 'dup.txt': 'x\nx\n' }, acceptAll);
    const run = tx.beginRun();
    const missing = await tx.execute(run.token, 'propose_write', { path: 'helpers.py', edits: [{ old_text: 'nope', new_text: 'y' }] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/old_text was not found.*Nothing was staged/);
    const twice = await tx.execute(run.token, 'propose_write', { path: 'dup.txt', edits: [{ old_text: 'x', new_text: 'y' }] });
    expect(twice.text).toMatch(/occurs 2 times/);
    expect(files['dup.txt']).toBe('x\nx\n');
  });

  it('strips a read_file gutter copied into old_text and new_text', () => {
    const out = applyTextEdits(BASE, [
      {
        old_text: '3      val = os.environ.get("FLASK_DEBUG")',
        new_text: '3      val = os.environ.get("FLASK_DEBUG", "")',
      },
    ]);
    expect(out.ok && out.text).toContain('os.environ.get("FLASK_DEBUG", "")');
    expect(out.ok && out.text).not.toMatch(/^3 /m);
  });

  it('strips trailing whitespace from complete lines of new_text, not from its last line', () => {
    const out = applyTextEdits(BASE.replace(/\n/g, '\r\n'), [
      { old_text: 'enabled."""', new_text: 'enabled.  \n    \n    More."""' },
      { old_text: 'val = ', new_text: 'value = ' },
    ]);
    expect(out.ok && out.text).toContain('enabled.\r\n\r\n    More."""\r\n');
    expect(out.ok && out.text).toContain('    value = os.environ');
  });

  it('keeps CRLF line endings', () => {
    const crlf = BASE.replace(/\n/g, '\r\n');
    const out = applyTextEdits(crlf, [{ old_text: 'enabled."""', new_text: 'enabled.\n    More."""' }]);
    expect(out.ok && out.text).toContain('enabled.\r\n    More."""\r\n');
  });
});

describe('replace_selection (inline edit)', () => {
  it('diffs the replacement against the selected lines only', async () => {
    const { tx, files } = setup({ 'helpers.py': `import os\n\n${BASE}` }, acceptAll);
    const lines = files['helpers.py']!.split('\n');
    const run = tx.beginRun({ path: 'helpers.py', startLine: 2, endLine: 6, text: lines.slice(2, 6).join('\n') });
    const replacement = '```python\n' + lines.slice(2, 6).join('\n').replace('"no"}', '"no", "off", "n"}') + '\n```';
    expect(await tx.reviewForApproval(run.id, 'replace_selection', { new_text: replacement })).toEqual({ allow: true });
    const out = await tx.execute(run.token, 'replace_selection', { new_text: replacement });
    expect(out.text).toMatch(/hunk \w+ \(line 6\): applied/);
    expect(files['helpers.py']).toBe(`import os\n\n${BASE.replace('"no"}', '"no", "off", "n"}')}`);
  });

  it('strips trailing whitespace from new lines before the hunks are computed', async () => {
    const seen: Proposal[] = [];
    const { tx, files } = setup({ 'helpers.py': BASE }, (p, t) => {
      seen.push(p);
      acceptAll(p, t);
    });
    const selected = BASE.split('\n').slice(0, 4);
    const run = tx.beginRun({ path: 'helpers.py', startLine: 0, endLine: 4, text: selected.join('\n') });
    // What the 7B model sent: a line of four spaces before the new docstring sentence.
    const replacement = [
      selected[0],
      '    """Get whether debug mode should be enabled.',
      '    ',
      '    Values treated as false: 0, false, no, off, n.\t ',
      '    """',
      selected[2],
      selected[3]!.replace('"no"}', '"no", "off", "n"}'),
    ].join('\n');
    await tx.reviewForApproval(run.id, 'replace_selection', { new_text: replacement });
    await tx.execute(run.token, 'replace_selection', { new_text: replacement });
    const added = seen[0]!.hunks.flatMap((h) => h.newLines);
    expect(added).toContain('');
    expect(added).toContain('    Values treated as false: 0, false, no, off, n.');
    expect(added.filter((l) => /[ \t]$/.test(l))).toEqual([]);
    expect(files['helpers.py']).not.toMatch(/[ \t]$/m);
  });

  it('leaves trailing whitespace on lines the edit does not change', async () => {
    const base = 'first line  \nsecond\n';
    const { tx, files } = setup({ 'notes.md': base }, acceptAll);
    const run = tx.beginRun({ path: 'notes.md', startLine: 0, endLine: 2, text: 'first line  \nsecond' });
    await tx.reviewForApproval(run.id, 'replace_selection', { new_text: 'first line  \nsecond, changed  ' });
    await tx.execute(run.token, 'replace_selection', { new_text: 'first line  \nsecond, changed  ' });
    expect(files['notes.md']).toBe('first line  \nsecond, changed\n');
  });

  it('is refused outside an inline run', async () => {
    const { tx } = setup({ 'helpers.py': BASE });
    const out = await tx.execute(tx.beginRun().token, 'replace_selection', { new_text: 'x' });
    expect(out.text).toMatch(/only available in an inline edit run/);
  });
});

describe('diff helpers', () => {
  it('finds separate changes', () => {
    const changes = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e']);
    expect(changes).toEqual([
      { baseStart: 1, baseEnd: 2, oldLines: ['b'], newLines: ['B'] },
      { baseStart: 4, baseEnd: 4, oldLines: [], newLines: ['e'] },
    ]);
  });

  it('only strips consecutive gutters', () => {
    expect(stripLineGutter('1  a\n2  b').text).toBe('a\nb');
    expect(stripLineGutter('1  a\n5  b').stripped).toBe(false);
    expect(stripLineGutter('return 1').stripped).toBe(false);
  });
});

describe('agent runs: accepted hunks are held across files and written as one edit', () => {
  const A = 'alpha\nbeta\ngamma\n';
  const B = 'one\ntwo\nthree\n';
  const C = 'red\ngreen\n';

  /** Like setup(), with applyAll: counts multi-file edits and can refuse one file. */
  function multi(files: Record<string, string>, reviewer: Reviewer = acceptAll) {
    const s = setup(files, reviewer);
    const batches: string[][] = [];
    const host = (s.tx as unknown as { host: EditorHost }).host;
    host.applyAll = async (changes) => {
      for (const c of changes) if (files[c.path] !== c.baseText) return { changed: c.path };
      for (const c of changes) {
        let text = c.baseText;
        for (const e of [...c.edits].sort((x, y) => y.start - x.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
        files[c.path] = text;
      }
      batches.push(changes.map((c) => c.path));
      return 'ok';
    };
    return { ...s, batches };
  }
  const edit = (path: string, old_text: string, new_text: string) => ({ path, edits: [{ old_text, new_text }] });

  it('writes nothing until commit, then all files in one edit, and records one undo', async () => {
    const { tx, files, batches, applied } = multi({ 'a.py': A, 'b.py': B, 'c.md': C });
    const run = tx.beginRun(undefined, { deferred: true });
    const r1 = await tx.execute(run.token, 'propose_write', edit('a.py', 'beta', 'BETA'));
    expect(r1.isError).toBe(false);
    expect(r1.text).toMatch(/accepted by the user and staged; not on disk yet/);
    expect(r1.text).toMatch(/nothing is on disk yet/);
    await tx.execute(run.token, 'propose_write', edit('b.py', 'two', 'TWO'));
    await tx.execute(run.token, 'propose_write', edit('c.md', 'green', 'GREEN'));
    expect(files).toEqual({ 'a.py': A, 'b.py': B, 'c.md': C });
    expect(await tx.readForRun(run.token, 'a.py')).toBe('alpha\nBETA\ngamma\n');

    const commit = await tx.commit(run.id);
    expect(commit).toMatchObject({ ok: true, hunks: 3 });
    expect(batches).toEqual([['a.py', 'b.py', 'c.md']]);
    expect(applied).toEqual([]);
    expect(files).toEqual({ 'a.py': 'alpha\nBETA\ngamma\n', 'b.py': 'one\nTWO\nthree\n', 'c.md': 'red\nGREEN\n' });
    expect(tx.proposalsFor(run.id).every((p) => p.state === 'applied' && p.hunks.every((h) => h.status === 'applied'))).toBe(true);
    expect(tx.lastApplied?.files.map((f) => [f.path, f.before])).toEqual([['a.py', A], ['b.py', B], ['c.md', C]]);
    tx.endRun(run.id, 'finished');
    expect(await tx.rollback(run.id)).toEqual(['a.py', 'b.py', 'c.md']); // only the Runner decides when; data is still there
  });

  it('a second edit to the same file builds on the staged text', async () => {
    const { tx, files } = multi({ 'a.py': A });
    const run = tx.beginRun(undefined, { deferred: true });
    await tx.execute(run.token, 'propose_write', edit('a.py', 'beta', 'BETA'));
    const again = await tx.execute(run.token, 'propose_write', edit('a.py', 'BETA\ngamma', 'BETA\nGAMMA'));
    expect(again.isError).toBe(false);
    await tx.commit(run.id);
    expect(files['a.py']).toBe('alpha\nBETA\nGAMMA\n');
    expect(tx.lastApplied?.files).toEqual([{ path: 'a.py', before: A, after: 'alpha\nBETA\nGAMMA\n' }]);
  });

  it('cancel discards everything staged in every file and writes nothing', async () => {
    const { tx, files, batches } = multi({ 'a.py': A, 'b.py': B });
    const run = tx.beginRun(undefined, { deferred: true });
    await tx.execute(run.token, 'propose_write', edit('a.py', 'beta', 'BETA'));
    await tx.execute(run.token, 'propose_write', edit('b.py', 'two', 'TWO'));
    tx.endRun(run.id, 'cancelled');
    expect(await tx.rollback(run.id)).toEqual([]);
    expect(files).toEqual({ 'a.py': A, 'b.py': B });
    expect(batches).toEqual([]);
    expect(tx.proposalsFor(run.id).every((p) => p.state === 'discarded')).toBe(true);
    expect((await tx.commit(run.id)).ok).toBe(false);
    expect(files).toEqual({ 'a.py': A, 'b.py': B });
  });

  it('a failed run takes back what an earlier commit wrote, as one edit', async () => {
    const { tx, files, batches } = multi({ 'a.py': A, 'b.py': B });
    const run = tx.beginRun(undefined, { deferred: true });
    await tx.execute(run.token, 'propose_write', edit('a.py', 'beta', 'BETA'));
    await tx.execute(run.token, 'propose_write', edit('b.py', 'two', 'TWO'));
    await tx.commit(run.id); // e.g. before run_command
    await tx.execute(run.token, 'propose_write', edit('a.py', 'gamma', 'GAMMA')); // held, never committed
    tx.endRun(run.id, 'failed');
    expect(await tx.rollback(run.id)).toEqual(['a.py', 'b.py']);
    expect(files).toEqual({ 'a.py': A, 'b.py': B });
    expect(batches).toEqual([['a.py', 'b.py'], ['a.py', 'b.py']]);
    expect(tx.lastApplied).toBeUndefined();
    expect(tx.proposalsFor(run.id).flatMap((p) => p.hunks).every((h) => h.status === 'failed')).toBe(true);
  });

  it('commit is all or nothing when a file changed outside Ripple', async () => {
    const { tx, files, batches } = multi({ 'a.py': A, 'b.py': B });
    const run = tx.beginRun(undefined, { deferred: true });
    await tx.execute(run.token, 'propose_write', edit('a.py', 'beta', 'BETA'));
    await tx.execute(run.token, 'propose_write', edit('b.py', 'two', 'TWO'));
    files['b.py'] = 'edited by the user\n';
    const commit = await tx.commit(run.id);
    expect(commit.ok).toBe(false);
    expect(commit.error).toMatch(/b\.py changed outside Ripple/);
    expect(files['a.py']).toBe(A);
    expect(batches).toEqual([]);
  });

  it('rejected hunks stay out of the staged text and are reported', async () => {
    const { tx, files } = multi({ 'helpers.py': BASE }, (p, t) => {
      t.decide(p.id, p.hunks[0]!.id, false, 'leave the docstring');
      t.decide(p.id, p.hunks[1]!.id, true);
    });
    const run = tx.beginRun(undefined, { deferred: true });
    const out = await tx.execute(run.token, 'propose_write', twoHunkEdit);
    expect(out.text).toMatch(/rejected by user: leave the docstring/);
    expect(out.text).toMatch(/1 of 2 hunk\(s\) are staged/);
    await tx.commit(run.id);
    expect(files['helpers.py']).toContain('"off", "n"');
    expect(files['helpers.py']).not.toContain('Off values');
  });
});
