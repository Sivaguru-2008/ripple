// Workspace search for Ripple MCP server (ripgrep with fast fallback). No `vscode` imports.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { listWorkspaceFiles } from './workspaceFiles';
import { resolveInWorkspace } from './paths';

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  totalMatches: number;
  capped: boolean;
  formatted: string;
}

const DEFAULT_MAX_MATCHES = 50;
const MAX_LINE_LENGTH = 300;
const MAX_FILE_SIZE = 500_000; // Skip files > 500KB in fallback

/** Simple glob matcher supporting *, **, and ? without heavy external dependencies. */
export function matchesGlob(filePath: string, globPattern?: string): boolean {
  if (!globPattern || globPattern === '*' || globPattern === '**' || globPattern === '**/*') return true;
  const p = filePath.replace(/\\/g, '/');
  const g = globPattern.replace(/\\/g, '/');
  
  let pattern = '';
  let i = 0;
  while (i < g.length) {
    if (g.slice(i, i + 3) === '**/') {
      pattern += '(?:.+/)?';
      i += 3;
    } else if (g.slice(i, i + 2) === '**') {
      pattern += '.*';
      i += 2;
    } else if (g[i] === '*') {
      pattern += '[^/]*';
      i += 1;
    } else if (g[i] === '?') {
      pattern += '[^/]';
      i += 1;
    } else if ('[.+^${}()|\\]'.includes(g[i]!)) {
      pattern += '\\' + g[i];
      i += 1;
    } else {
      pattern += g[i];
      i += 1;
    }
  }
  const re = new RegExp(`^${pattern}$`, 'i');
  return re.test(p) || re.test(path.basename(p));
}

/** Tries to locate a bundled or installed ripgrep binary. */
function findRipgrep(): string | undefined {
  if (process.env['RIPGREP_PATH'] && existsSync(process.env['RIPGREP_PATH'])) {
    return process.env['RIPGREP_PATH'];
  }
  // Check common VS Code unpacked ripgrep locations on Windows/Linux/Mac
  const localApp = process.env['LOCALAPPDATA'];
  if (localApp) {
    const vsCodeBase = path.join(localApp, 'Programs', 'Microsoft VS Code');
    if (existsSync(vsCodeBase)) {
      const candidates = [
        path.join(vsCodeBase, 'resources', 'app', 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
    }
  }
  return undefined;
}

/** Searches workspace with ripgrep if available, falling back to fast in-memory search. */
export async function searchWorkspace(
  root: string,
  query: string,
  globPattern?: string,
  maxMatches = DEFAULT_MAX_MATCHES,
): Promise<SearchResult> {
  if (!query.trim()) {
    return { matches: [], totalMatches: 0, capped: false, formatted: 'Empty search query.' };
  }

  const rgPath = findRipgrep();
  if (rgPath) {
    try {
      return await searchWithRipgrep(rgPath, root, query, globPattern, maxMatches);
    } catch {
      // Fallback to in-process scanning on any ripgrep error
    }
  }

  return searchFallback(root, query, globPattern, maxMatches);
}

function searchWithRipgrep(
  rgPath: string,
  root: string,
  query: string,
  globPattern: string | undefined,
  maxMatches: number,
): Promise<SearchResult> {
  const args = [
    '--line-number',
    '--no-heading',
    '--color=never',
    '--fixed-strings',
    '-i',
    '--max-count',
    String(maxMatches),
    '--max-columns',
    String(MAX_LINE_LENGTH),
  ];
  if (globPattern) {
    args.push('-g', globPattern);
  }
  args.push(query, '.');

  return new Promise((resolve, reject) => {
    execFile(rgPath, args, { cwd: root, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf-8' }, (err, stdout) => {
      if (err && err.code !== 1) {
        return reject(err);
      }
      const lines = (stdout || '').split(/\r?\n/).filter(Boolean);
      const matches: SearchMatch[] = [];
      for (const line of lines) {
        if (matches.length >= maxMatches) break;
        const match = /^([^:]+):(\d+):(.*)$/.exec(line);
        if (match && match[1] && match[2]) {
          const rel = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
          matches.push({
            path: rel,
            line: parseInt(match[2], 10),
            text: (match[3] ?? '').trimEnd(),
          });
        }
      }
      const capped = matches.length >= maxMatches;
      const formatted = formatMatches(matches, capped, query);
      resolve({ matches, totalMatches: matches.length, capped, formatted });
    });
  });
}

async function searchFallback(
  root: string,
  query: string,
  globPattern: string | undefined,
  maxMatches: number,
): Promise<SearchResult> {
  const files = await listWorkspaceFiles(root);
  const targetFiles = files.filter((f) => matchesGlob(f, globPattern));
  const queryLower = query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (const rel of targetFiles) {
    if (matches.length >= maxMatches) break;
    const fullPath = resolveInWorkspace(root, rel);
    try {
      const content = await readFile(fullPath, 'utf-8');
      if (content.length > MAX_FILE_SIZE) continue;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i]!;
        if (lineText.toLowerCase().includes(queryLower)) {
          matches.push({
            path: rel.replace(/\\/g, '/'),
            line: i + 1,
            text: lineText.length > MAX_LINE_LENGTH ? `${lineText.slice(0, MAX_LINE_LENGTH)}...` : lineText,
          });
          if (matches.length >= maxMatches) break;
        }
      }
    } catch {
      // Ignore unreadable files (binary, permissions)
    }
  }

  const capped = matches.length >= maxMatches;
  const formatted = formatMatches(matches, capped, query);
  return { matches, totalMatches: matches.length, capped, formatted };
}

function formatMatches(matches: SearchMatch[], capped: boolean, query: string): string {
  if (matches.length === 0) {
    return `No matches found for "${query}".`;
  }
  const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
  if (capped) {
    lines.push(`\n[Results capped at ${matches.length} matches. Use a more specific query or glob if needed.]`);
  }
  return lines.join('\n');
}
