import * as path from 'node:path';

/**
 * Resolves a tool-supplied path against the workspace root and rejects anything that
 * escapes it or attempts to access internal VCS or secret configuration files.
 * Accepts forward or back slashes; returns an absolute native path.
 */
export function resolveInWorkspace(root: string, requested: string): string {
  if (requested.trim() === '') throw new Error('path is empty');
  if (requested.includes('\0')) throw new Error('path contains invalid characters');

  const normalised = requested.replace(/\\/g, '/');
  // Check for colon (alternate data streams) beyond an optional Windows drive prefix (e.g. C:)
  const withoutDrive = /^[a-zA-Z]:/.test(normalised) ? normalised.slice(2) : normalised;
  if (withoutDrive.includes(':')) {
    throw new Error(`path contains invalid characters: ${requested}`);
  }

  const absolute = path.resolve(root, normalised);
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path is outside the workspace: ${requested}`);
  }

  // Reject access to .git repository metadata/hooks
  const segments = relative.split('/');
  if (segments.includes('.git')) {
    throw new Error(`access to internal git directory is forbidden: ${requested}`);
  }

  // Protect sensitive root-level environment secret files (.env, .env.local, etc.)
  // (allows .env.example, .env.sample, .env.template, or fixtures in subdirectories)
  if (segments.length === 1 && /^\.env(?:\.(?!example$|sample$|template$)[^.]+)*$/i.test(segments[0]!)) {
    throw new Error(`access to sensitive environment file is forbidden: ${requested}`);
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

/** Most lines one read_file call returns; about 1,500 tokens of code. */
export const READ_FILE_MAX_LINES = 120;

/**
 * read_file output: numbered lines, at most `maxLines` per call. A whole large file would
 * push a small model's instructions out of its context window, so the reply says what was
 * left out and how to get it.
 */
export function readWindow(text: string, start?: number, end?: number, maxLines = READ_FILE_MAX_LINES): string {
  const total = text.split(/\r?\n/).length;
  const first = Math.max(1, start ?? 1);
  const wanted = Math.min(total, end ?? total);
  if (first > wanted) return `(no lines in that range; the file has ${total} lines)`;
  const last = Math.min(wanted, first + maxLines - 1);
  const body = withLineNumbers(text, first, last);
  if (last >= total && first === 1) return body;
  const note =
    last < wanted
      ? `[lines ${first}-${last} of ${total}; at most ${maxLines} lines per call. Call read_file with start=${last + 1} for more, or search_workspace to find the lines you need.]`
      : `[lines ${first}-${last} of ${total}]`;
  return `${body}\n${note}`;
}
