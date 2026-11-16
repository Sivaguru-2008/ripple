import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { matchesGlob, searchWorkspace } from '../src/core/search';

describe('searchWorkspace', () => {
  const root = path.resolve(__dirname, '..');

  it('matches glob patterns correctly', () => {
    expect(matchesGlob('src/core/search.ts', '*.ts')).toBe(true);
    expect(matchesGlob('src/core/search.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/core/search.ts', 'test/**/*.ts')).toBe(false);
    expect(matchesGlob('README.md', '*.md')).toBe(true);
  });

  it('finds symbols in the workspace and returns formatted lines', async () => {
    const result = await searchWorkspace(root, 'searchWorkspace', '*.ts');
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.some((m) => m.path.includes('search.ts'))).toBe(true);
    expect(result.formatted).toContain('searchWorkspace');
  });

  it('handles empty or not found queries cleanly', async () => {
    // Generate a random search string dynamically so it is not in the source text
    const randomQuery = `no_match_${Date.now()}_${Math.random()}`;
    const result = await searchWorkspace(root, randomQuery);
    expect(result.matches.length).toBe(0);
    expect(result.formatted).toContain('No matches found');
  });
});
