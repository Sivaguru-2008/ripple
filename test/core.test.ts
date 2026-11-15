import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateToken, isAuthorized } from '../src/core/auth';
import { resolveInWorkspace, withLineNumbers } from '../src/core/paths';

describe('isAuthorized', () => {
  const token = generateToken();

  it('accepts the exact bearer token', () => {
    expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
  });

  it('rejects missing, wrong or malformed headers', () => {
    expect(isAuthorized(undefined, token)).toBe(false);
    expect(isAuthorized('Bearer nope', token)).toBe(false);
    expect(isAuthorized(token, token)).toBe(false);
    expect(isAuthorized(`Basic ${token}`, token)).toBe(false);
  });
});

describe('resolveInWorkspace', () => {
  const root = path.resolve('/work/repo');

  it('resolves relative paths with either slash', () => {
    expect(resolveInWorkspace(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(resolveInWorkspace(root, 'src\\a.ts')).toBe(path.join(root, 'src', 'a.ts'));
  });

  it('rejects escapes and the root itself', () => {
    expect(() => resolveInWorkspace(root, '../secret')).toThrow();
    expect(() => resolveInWorkspace(root, '.')).toThrow();
    expect(() => resolveInWorkspace(root, '')).toThrow();
  });
});

describe('withLineNumbers', () => {
  const text = 'a\nb\r\nc';

  it('numbers every line by default', () => {
    expect(withLineNumbers(text)).toBe('1  a\n2  b\n3  c');
  });

  it('clamps the requested range', () => {
    expect(withLineNumbers(text, 2, 99)).toBe('2  b\n3  c');
    expect(withLineNumbers(text, 3, 2)).toBe('');
  });
});
