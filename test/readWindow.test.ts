import { describe, expect, it } from 'vitest';
import { calculateRetrievalBudget } from '../src/core/budget';
import { readWindow } from '../src/core/paths';

const file = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n');

describe('readWindow', () => {
  it('returns a short file whole, with no note', () => {
    const out = readWindow(file(3));
    expect(out).toBe('1  line 1\n2  line 2\n3  line 3');
  });

  it('caps a long file and says how to read on', () => {
    const out = readWindow(file(1000), undefined, undefined, 250);
    const lines = out.split('\n');
    expect(lines.length).toBe(251);
    expect(lines[249]).toBe('250  line 250');
    expect(lines[250]).toContain('lines 1-250 of 1000');
    expect(lines[250]).toContain('start=251');
  });

  it('caps an open-ended range from start', () => {
    const out = readWindow(file(1000), 251, undefined, 250);
    expect(out.startsWith('251  line 251')).toBe(true);
    expect(out).toContain('lines 251-500 of 1000');
    expect(out).toContain('start=501');
  });

  it('reports a range that fits without a paging hint', () => {
    const out = readWindow(file(1000), 10, 12);
    expect(out).toBe('10  line 10\n11  line 11\n12  line 12\n[lines 10-12 of 1000]');
  });

  it('explains an empty range', () => {
    expect(readWindow(file(5), 9, 12)).toBe('(no lines in that range; the file has 5 lines)');
  });
});

describe('default retrieval share', () => {
  it('takes at most 30% of a small window', () => {
    const b = calculateRetrievalBudget({ contextWindow: 16384 });
    expect(b.effectiveBudget).toBe(4915);
  });

  it('still caps a large window at 8000', () => {
    expect(calculateRetrievalBudget({ contextWindow: 131072 }).effectiveBudget).toBe(8000);
  });

  it('leaves an explicit request alone', () => {
    expect(calculateRetrievalBudget({ contextWindow: 16384, requestedBudget: 7000 }).effectiveBudget).toBe(7000);
  });
});
