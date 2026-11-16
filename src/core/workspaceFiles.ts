// Lists and reads workspace files for the retriever. No `vscode` imports.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveInWorkspace } from './paths';
import type { RetrieveSource } from './retrieve';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', '.tox']);
const MAX_WALK = 5000;

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length < MAX_WALK) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(rel);
      } else if (e.isFile()) out.push(rel);
    }
  }
  return out;
}

/** Tracked and untracked-but-not-ignored files; a plain directory walk when git is not usable. */
export function listWorkspaceFiles(root: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', 'ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf-8' },
      (err, stdout) => {
        if (err) void walk(root).then(resolve);
        else resolve(stdout.split(/\r?\n/).filter(Boolean));
      },
    );
  });
}

/**
 * A retriever source over the files on disk. `overlay` returns newer text for a path when
 * there is one (an unsaved editor buffer, or edits staged in the current run).
 */
export function diskSource(root: string, overlay?: (path: string) => string | undefined): RetrieveSource {
  return {
    listFiles: () => listWorkspaceFiles(root),
    readText: async (p) => overlay?.(p) ?? (await readFile(resolveInWorkspace(root, p), 'utf-8')),
  };
}
