import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCochange, clearCochangeCache, mineCochange } from '../src/core/cochange';

const M = '\u0001';
const commit = (hash: string, ...lines: string[]): string => `${M}${hash}\n\n${lines.join('\n')}\n`;

describe('buildCochange', () => {
  it('normalises by how often each file changes', () => {
    const log = [
      commit('c5', 'M\ta.py', 'M\ttest_a.py', 'M\tCHANGES'),
      commit('c4', 'M\ta.py', 'M\ttest_a.py'),
      commit('c3', 'M\tb.py', 'M\tCHANGES'),
      commit('c2', 'M\tc.py', 'M\tCHANGES'),
      commit('c1', 'M\td.py', 'M\tCHANGES'),
    ].join('');
    const idx = buildCochange(log);
    expect(idx.available).toBe(true);
    expect(idx.commitCount('CHANGES')).toBe(4);
    const n = idx.neighbours('a.py');
    expect(n.map((x) => x.path)).toEqual(['test_a.py', 'CHANGES']);
    expect(n[0]).toMatchObject({ shared: 2, score: 1 });
    expect(n[1]?.score).toBeCloseTo(1 / Math.sqrt(2 * 4));
  });

  it('follows renames, including ones made in a skipped oversized commit', () => {
    const many = Array.from({ length: 25 }, (_, k) => `M\tother${k}.py`);
    const log = [
      commit('c4', 'M\tsrc/pkg/cli.py', 'M\ttests/test_cli.py'),
      commit('c3', 'R100\tpkg/cli.py\tsrc/pkg/cli.py', ...many),
      commit('c2', 'M\tpkg/cli.py', 'M\ttests/test_cli.py'),
      commit('c1', 'A\tpkg/cli.py', 'A\ttests/test_cli.py'),
    ].join('');
    const idx = buildCochange(log);
    expect(idx.commits).toBe(3);
    expect(idx.commitCount('src/pkg/cli.py')).toBe(3);
    expect(idx.commitCount('pkg/cli.py')).toBe(0);
    expect(idx.neighbours('src/pkg/cli.py')[0]).toMatchObject({ path: 'tests/test_cli.py', shared: 3 });
  });

  it('drops files that no longer exist when the head file list is given', () => {
    const log = commit('c1', 'M\ta.py', 'M\tgone.py', 'M\tb.py');
    const idx = buildCochange(log, ['a.py', 'b.py']);
    expect(idx.neighbours('a.py').map((x) => x.path)).toEqual(['b.py']);
  });

  it('reports an empty history as unavailable', () => {
    const idx = buildCochange('');
    expect(idx.available).toBe(false);
    expect(idx.neighbours('a.py')).toEqual([]);
  });
});

describe('mineCochange', () => {
  it('does not throw outside a git repository', async () => {
    clearCochangeCache();
    const dir = mkdtempSync(path.join(tmpdir(), 'ripple-nogit-'));
    const idx = await mineCochange(dir);
    expect(idx.available).toBe(false);
    expect(idx.reason).toMatch(/no git history/);
    expect(idx.neighbours('x')).toEqual([]);
  });

  it('degrades on a shallow clone', async () => {
    clearCochangeCache();
    const base = mkdtempSync(path.join(tmpdir(), 'ripple-shallow-'));
    const origin = path.join(base, 'origin');
    const run = (cwd: string, ...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
    };
    execFileSync('git', ['init', '--quiet', origin], { stdio: 'ignore' });
    for (const n of [1, 2, 3]) {
      writeFileSync(path.join(origin, 'a.txt'), `v${n}\n`);
      writeFileSync(path.join(origin, 'b.txt'), `v${n}\n`);
      run(origin, 'add', '-A');
      run(origin, 'commit', '--quiet', '-m', `c${n}`);
    }
    const full = await mineCochange(origin);
    expect(full.available).toBe(true);
    expect(full.neighbours('a.txt')[0]).toMatchObject({ path: 'b.txt', shared: 3 });

    const shallow = path.join(base, 'shallow');
    execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${origin.replace(/\\/g, '/')}`, shallow], { stdio: 'ignore' });
    const idx = await mineCochange(shallow);
    expect(idx.available).toBe(false);
    expect(idx.reason).toMatch(/shallow/);
  });
});

// Needs a full-history clone of pallets/flask (see test/integration/runTest.mjs).
const flask = process.env['RIPPLE_FLASK_REPO'] ?? path.resolve(__dirname, '..', '..', 'forge-refs', 'flask');
const flaskAt313 = ((): boolean => {
  try {
    return existsSync(flask) && execFileSync('git', ['-C', flask, 'describe', '--tags', '--exact-match'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '3.1.3';
  } catch {
    return false;
  }
})();

describe.skipIf(!flaskAt313)('co-change on flask 3.1.3', () => {
  it('ranks the CLI tests and docs above the changelog for src/flask/cli.py', async () => {
    clearCochangeCache();
    const idx = await mineCochange(flask);
    expect(idx.available).toBe(true);
    const n = idx.neighbours('src/flask/cli.py', 200);
    const rank = (p: string): number => n.findIndex((x) => x.path === p);
    console.log(n.slice(0, 8).map((x) => `${x.path} shared=${x.shared} score=${x.score.toFixed(3)}`).join('\n'));
    console.log(`CHANGES.rst rank ${rank('CHANGES.rst')}, commits(cli.py)=${idx.commitCount('src/flask/cli.py')}`);
    expect(rank('tests/test_cli.py')).toBeGreaterThanOrEqual(0);
    expect(rank('docs/cli.rst')).toBeGreaterThanOrEqual(0);
    expect(rank('CHANGES.rst')).toBeGreaterThanOrEqual(0);
    expect(rank('tests/test_cli.py')).toBeLessThan(rank('CHANGES.rst'));
    expect(rank('docs/cli.rst')).toBeLessThan(rank('CHANGES.rst'));
  }, 60_000);
});
