import * as path from 'node:path';

/**
 * Resolves a tool-supplied path against the workspace root and rejects anything that
 * escapes it. Accepts forward or back slashes; returns an absolute native path.
 */
export function resolveInWorkspace(root: string, requested: string): string {
  if (requested.trim() === '') throw new Error('path is empty');
  const normalised = requested.replace(/\\/g, '/');
  const absolute = path.resolve(root, normalised);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path is outside the workspace: ${requested}`);
  }
  return absolute;
}

/**
 * Returns `text` with 1-based line numbers, optionally limited to [start, end] (inclusive).
 */
export function withLineNumbers(text: string, start?: number, end?: number): string {
  const lines = text.split(/\r?\n/);
  const first = Math.max(1, start ?? 1);
  const last = Math.min(lines.length, end ?? lines.length);
  if (first > last) return '';
  const width = String(last).length;
  const out: string[] = [];
  for (let n = first; n <= last; n++) {
    out.push(`${String(n).padStart(width, ' ')}  ${lines[n - 1] ?? ''}`);
  }
  return out.join('\n');
}
