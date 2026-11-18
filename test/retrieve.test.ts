import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCochange, clearCochangeCache, mineCochange } from '../src/core/cochange';
import { estimateTokens, findSymbols, queryTerms, retrieve, symbolBlock, type RetrieveSource } from '../src/core/retrieve';
import { diskSource } from '../src/core/workspaceFiles';

function source(files: Record<string, string>): RetrieveSource {
  return {
    listFiles: async () => Object.keys(files),
    readText: async (p) => {
      const text = files[p];
      if (text === undefined) throw new Error(`no such file ${p}`);
      return text;
    },
  };
}

const filler = (name: string, lines: number): string =>
  Array.from({ length: lines }, (_, k) => `def ${name}_${k}(value):\n    return value + ${k}\n`).join('\n');

const repo: Record<string, string> = {
  'src/shop/cart.py': `from .pricing import total_price\nfrom . import storage\n\nclass Cart:\n    def add_item(self, item):\n        self.items.append(item)\n\n    def checkout(self):\n        return total_price(self.items)\n`,
  'src/shop/pricing.py': `def total_price(items):\n    return sum(i.price for i in items)\n`,
  'src/shop/storage.py': `def save(cart):\n    pass\n`,
  'src/shop/orders.py': `from .cart import Cart\n\ndef place(cart: Cart):\n    return cart.checkout()\n`,
  'tests/test_cart.py': `from shop.cart import Cart\n\ndef test_add_item():\n    assert Cart()\n`,
  'docs/cart.rst': `Cart\n====\n\nHow the shopping basket works.\n`,
  'docs/install.rst': `Install\n=======\n\npip install shop\n`,
  'CHANGES.rst': `Version 2\n---------\n\n- Things changed.\n`,
  'src/shop/big.py': filler('helper', 600),
};

const M = '\u0001';
const log = [
  `${M}c4\n\nM\tsrc/shop/cart.py\nM\ttests/test_cart.py\nM\tCHANGES.rst\n`,
  `${M}c3\n\nM\tsrc/shop/cart.py\nM\ttests/test_cart.py\nM\tdocs/cart.rst\n`,
  `${M}c2\n\nM\tsrc/shop/pricing.py\nM\tCHANGES.rst\n`,
  `${M}c1\n\nM\tsrc/shop/storage.py\nM\tCHANGES.rst\nM\tdocs/install.rst\n`,
].join('');

describe('queryTerms', () => {
  it('drops stopwords and stems', () => {
    expect(queryTerms('Add the commands for masking a configKey')).toEqual(['command', 'mask', 'config', 'key']);
  });
});

describe('symbolBlock', () => {
  it('covers a definition with its decorator and body', () => {
    const lines = ['import x', '', '@cli.command()', 'def run(a):', '    one()', '', '    two()', '', 'def other():', '    pass'];
    const run = findSymbols(lines).find((s) => s.name === 'run')!;
    expect(symbolBlock(lines, run)).toEqual({ start: 2, end: 7 });
  });
});

describe('retrieve', () => {
  it('finds the seed lexically and expands by co-change, pairing and imports', async () => {
    const r = await retrieve('Let the Cart apply a discount at checkout', source(repo), { cochange: buildCochange(log) });
    const row = (p: string) => r.receipt.find((x) => x.path === p);
    expect(r.receipt.slice(0, 2).map((x) => x.path).sort()).toEqual(['src/shop/cart.py', 'tests/test_cart.py']);
    expect(row('src/shop/cart.py')?.reason).toBe('lexical');
    expect(row('tests/test_cart.py')?.evidence).toMatch(/changed with src\/shop\/cart\.py in 2 commits/);
    expect(row('tests/test_cart.py')?.evidence).toMatch(/test file paired with src\/shop\/cart\.py by name/);
    expect(row('docs/cart.rst')?.evidence).toMatch(/documentation paired with src\/shop\/cart\.py/);
    expect(row('src/shop/pricing.py')?.evidence).toMatch(/imported by src\/shop\/cart\.py/);
    expect(row('src/shop/orders.py')?.evidence).toMatch(/imports src\/shop\/cart\.py/);
    expect(r.text).toContain('=== src/shop/cart.py (full file');
    for (const f of r.files) expect(r.text).toContain(f.text.trimEnd());
  });

  it('never exceeds the budget, whatever it is', async () => {
    for (const budget of [1, 600, 900, 1500, 3000, 8000, 50_000]) {
      const r = await retrieve('helper value cart checkout price storage install', source(repo), { budgetTokens: budget, cochange: buildCochange(log) });
      expect(r.budgetTokens).toBe(Math.max(600, budget));
      expect(estimateTokens(r.text)).toBeLessThanOrEqual(r.budgetTokens);
      expect(r.usedTokens).toBe(estimateTokens(r.text));
      expect(r.receipt.reduce((n, x) => n + x.tokens, 0)).toBeLessThanOrEqual(r.budgetTokens);
    }
  });

  it('cuts a file that does not fit down to the relevant part, and lists what was evicted', async () => {
    const more = Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`src/shop/more${k}.py`, filler('helper', 300 + k)]));
    const r = await retrieve('change helper_7 and helper_300', source({ ...repo, ...more }), { budgetTokens: 1500 });
    const big = r.files.find((f) => f.path === 'src/shop/big.py');
    expect(big?.mode).toBe('excerpt');
    expect(big!.ranges.length).toBeGreaterThan(0);
    expect(big!.tokens).toBeLessThan(1500);
    expect(r.evicted.length).toBeGreaterThan(0);
    for (const e of r.evicted) {
      expect(e.reason).not.toBe('');
      expect(r.receipt.some((x) => x.path === e.path)).toBe(false);
    }
  });

  it('never evicts pinned mentions, even when they match nothing and the budget is tiny', async () => {
    const pins = [
      { path: 'docs/install.rst', label: '@install.rst' },
      { path: 'src/shop/big.py', label: '@big.py' },
      { path: 'src/shop/storage.py', startLine: 1, endLine: 2, label: '@save' },
    ];
    for (const budget of [600, 2000, 8000]) {
      const r = await retrieve('Let the Cart apply a discount at checkout', source(repo), { budgetTokens: budget, pins, cochange: buildCochange(log) });
      for (const pin of pins) {
        const row = r.receipt.find((x) => x.path === pin.path);
        expect(row?.reason, `${pin.path} at budget ${budget}`).toBe('pinned');
        expect(row?.evidence).toContain(pin.label);
        expect(r.evicted.some((e) => e.path === pin.path)).toBe(false);
      }
      expect(estimateTokens(r.text)).toBeLessThanOrEqual(r.budgetTokens);
    }
  });

  it('includes the pinned line range of a symbol mention', async () => {
    const r = await retrieve('unrelated words', source(repo), { pins: [{ path: 'src/shop/big.py', startLine: 301, endLine: 302, label: '@helper_100' }], budgetTokens: 900 });
    const big = r.files.find((f) => f.path === 'src/shop/big.py')!;
    expect(big.ranges.some((x) => x.start <= 301 && x.end >= 302)).toBe(true);
  });

  it('works with co-change disabled or unavailable', async () => {
    const off = await retrieve('Let the Cart apply a discount at checkout', source(repo));
    expect(off.notes.join(' ')).toMatch(/co-change signal disabled/);
    expect(off.receipt.some((x) => x.path === 'tests/test_cart.py')).toBe(true);
    expect(off.receipt.every((x) => !/changed with/.test(x.evidence))).toBe(true);
    const none = await retrieve('Let the Cart apply a discount at checkout', source(repo), { cochange: buildCochange('') });
    expect(none.notes.join(' ')).toMatch(/co-change signal unavailable/);
    expect(none.receipt.some((x) => x.path === 'src/shop/cart.py')).toBe(true);
  });

  it('returns an empty receipt with a note when nothing matches', async () => {
    const r = await retrieve('zzzz qqqq', source(repo));
    expect(r.receipt).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/no file matched/);
  });
});

// Needs a full-history clone of pallets/flask at 3.1.3 (see test/integration/runTest.mjs).
const flask = process.env['RIPPLE_FLASK_REPO'] ?? path.resolve(__dirname, '..', '..', 'forge-refs', 'flask');
const flaskAt313 = ((): boolean => {
  try {
    return existsSync(flask) && execFileSync('git', ['-C', flask, 'describe', '--tags', '--exact-match'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '3.1.3';
  } catch {
    return false;
  }
})();

const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

describe.skipIf(!flaskAt313)('retrieve on flask 3.1.3 (Task B request, no files named)', () => {
  it('returns the CLI source, its tests and its docs with co-change evidence, inside 8000 tokens', async () => {
    clearCochangeCache();
    const r = await retrieve(TASK_B, diskSource(flask), { cochange: await mineCochange(flask) });
    console.log(r.text.split('\n=== ')[0]);
    console.log(`used ${r.usedTokens} of ${r.budgetTokens}`);
    const row = (p: string) => r.receipt.find((x) => x.path === p);
    expect(row('src/flask/cli.py')).toBeDefined();
    expect(row('tests/test_cli.py')?.evidence).toMatch(/changed with src\/flask\/cli\.py in \d+ commits/);
    expect(row('docs/cli.rst')?.evidence).toMatch(/changed with src\/flask\/cli\.py in \d+ commits/);
    expect(r.usedTokens).toBeLessThanOrEqual(8000);
    expect(r.evicted.length).toBeGreaterThan(0);
  }, 60_000);

  it('maps the same three files in well under half the tokens', async () => {
    const cochange = await mineCochange(flask);
    const text = await retrieve(TASK_B, diskSource(flask), { cochange, budgetTokens: 4915 });
    const map = await retrieve(TASK_B, diskSource(flask), { cochange, budgetTokens: 4915, style: 'map' });
    for (const p of ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst']) {
      expect(map.receipt.find((x) => x.path === p)?.mode).toBe('outline');
    }
    expect(map.text).toMatch(/run_command\(/);
    expect(map.text).toMatch(/Open a Shell/);
    expect(map.usedTokens).toBeLessThan(text.usedTokens / 2);
  }, 60_000);
});

describe('map style', () => {
  it('outlines a large file by its definitions, with line ranges', async () => {
    const r = await retrieve('change helper_7 and helper_300', source(repo), { budgetTokens: 3000, style: 'map' });
    const big = r.files.find((f) => f.path === 'src/shop/big.py');
    expect(big?.mode).toBe('outline');
    expect(big?.text).toMatch(/most relevant lines: /);
    expect(big?.text).toMatch(/^\s+\d+-\d+\s+def helper_7\(value\):/m);
    // Capped: the rest are counted, not listed.
    expect(big?.text).toMatch(/\(\d+ more; search_workspace finds them\)/);
    expect(r.text).toContain('read_file(path, start, end)');
    expect(r.usedTokens).toBeLessThanOrEqual(3000);
  });

  it('sends small files whole and outlines docs by section', async () => {
    const docs = { ...repo, 'docs/guide.rst': `Guide\n=====\n\nIntro.\n\n${'text\n'.repeat(400)}\nCheckout\n--------\n\nHow checkout works.\n\n    def example():\n        pass\n` };
    const r = await retrieve('Let the Cart apply a discount at checkout', source(docs), { style: 'map', cochange: buildCochange(log) });
    expect(r.files.find((f) => f.path === 'src/shop/cart.py')?.mode).toBe('full');
    const guide = r.files.find((f) => f.path === 'docs/guide.rst');
    if (guide) {
      expect(guide.text).toMatch(/# Guide/);
      expect(guide.text).toMatch(/## Checkout/);
      expect(guide.text).not.toMatch(/def example/);
    }
  });

  it('keeps pinned line ranges as text', async () => {
    const r = await retrieve('unrelated words', source(repo), {
      pins: [{ path: 'src/shop/big.py', startLine: 301, endLine: 302, label: '@helper_100' }],
      budgetTokens: 900,
      style: 'map',
    });
    const big = r.files.find((f) => f.path === 'src/shop/big.py');
    expect(big?.mode).toBe('outline');
    expect(big?.text).toContain('301  def helper_100(value):');
    expect(r.receipt.find((x) => x.path === 'src/shop/big.py')?.reason).toBe('pinned');
  });

  it('sees an edit in the middle of a file even when its length and ends are unchanged', async () => {
    const pad = (c: string) => `${c} = 0\n`.repeat(40);
    const files: Record<string, string> = { 'src/mod.py': `${pad('x')}def alpha_handler():\n    pass\n${pad('y')}` };
    const first = await retrieve('alpha handler', source(files));
    expect(first.receipt.some((r) => r.path === 'src/mod.py')).toBe(true);
    // Same length, same first and last 100 characters, different middle.
    files['src/mod.py'] = files['src/mod.py']!.replace('alpha_handler', 'omega_handler');
    const second = await retrieve('omega handler', source(files));
    expect(second.receipt.find((r) => r.path === 'src/mod.py')?.evidence).toMatch(/omega/);
  });

  it('expands import neighbours for TypeScript/JavaScript codebases', async () => {
    const tsRepo: Record<string, string> = {
      'src/core/auth.ts': 'export function checkAuth() { return true; }\n',
      'src/core/server.ts': 'import { checkAuth } from "./auth";\nexport function start() { return checkAuth(); }\n',
      'test/server.test.ts': 'import { start } from "../src/core/server";\nexport function testServer() { start(); }\n',
    };
    const r = await retrieve('start the server', source(tsRepo), { budgetTokens: 4000 });
    const receiptPaths = r.receipt.map((x) => x.path);
    expect(receiptPaths).toContain('src/core/server.ts');
    // server.ts imports auth.ts, so auth.ts should be expanded via import relationship
    expect(receiptPaths).toContain('src/core/auth.ts');
    const authRow = r.receipt.find((x) => x.path === 'src/core/auth.ts');
    expect(authRow?.evidence).toMatch(/imported by src\/core\/server\.ts/);
  });
});
