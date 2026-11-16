import { describe, expect, it } from 'vitest';
import { describePins, parseMentions, resolveMentions } from '../src/core/mentions';
import type { RetrieveSource } from '../src/core/retrieve';

const files: Record<string, string> = {
  'src/flask/cli.py': 'import os\n\nclass FlaskGroup:\n    def get_command(self, ctx, name):\n        return None\n\n    def list_commands(self, ctx):\n        return []\n\ndef main():\n    pass\n',
  'src/flask/config.py': 'class Config(dict):\n    def from_file(self, name):\n        return True\n',
  'tests/test_cli.py': 'def test_main():\n    pass\n',
  'docs/cli.rst': 'CLI\n===\n',
  'docs/api/cli.rst': 'API\n===\n',
};
const source: RetrieveSource = {
  listFiles: async () => Object.keys(files),
  readText: async (p) => files[p] ?? Promise.reject(new Error('missing')),
};

describe('parseMentions', () => {
  it('finds @tokens and ignores e-mail addresses and trailing punctuation', () => {
    expect(parseMentions('Look at @src/flask/cli.py, then @FlaskGroup. Mail me@example.com (@Config.from_file)')).toEqual([
      'src/flask/cli.py',
      'FlaskGroup',
      'Config.from_file',
    ]);
  });
});

describe('resolveMentions', () => {
  it('resolves paths, unique file names and symbols', async () => {
    const r = await resolveMentions(['src/flask/cli.py', 'config.py', 'FlaskGroup', 'Config.from_file', 'main', 'nothing_here', 'x/y.zz'], source);
    expect(r.pins).toEqual([
      { path: 'src/flask/cli.py', label: '@src/flask/cli.py' },
      { path: 'src/flask/config.py', label: '@config.py' },
      { path: 'src/flask/cli.py', startLine: 3, endLine: 8, label: '@FlaskGroup' },
      { path: 'src/flask/config.py', startLine: 2, endLine: 3, label: '@Config.from_file' },
      { path: 'src/flask/cli.py', startLine: 10, endLine: 11, label: '@main' },
    ]);
    expect(r.unresolved).toEqual(['@x/y.zz', '@nothing_here']);
    expect(describePins(r)).toContain('- @FlaskGroup → src/flask/cli.py lines 3-8');
    expect(describePins(r)).toContain('- @nothing_here → not found in the workspace');
  });

  it('picks the shortest path for an ambiguous file name', async () => {
    const r = await resolveMentions(['cli.rst'], source);
    expect(r.pins).toEqual([{ path: 'docs/cli.rst', label: '@cli.rst' }]);
  });
});
