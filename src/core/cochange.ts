// Co-change mining (AGENTS.md section 3, part 2; RESEARCH.md section 3). No `vscode` imports.
//
// Two files that were committed together often tend to need each other. The history is read
// once per workspace with `git log -M --name-status` and turned into pair counts. Scores are
// normalised (shared / sqrt(commits(a) * commits(b))) so files that change with everything,
// like a changelog, do not win on raw count.
import { execFile } from 'node:child_process';

/** Commits touching more files than this say little about any pair and are skipped. */
export const MAX_FILES_PER_COMMIT = 20;

export interface CochangeNeighbour {
  path: string;
  /** Commits that touched both files. */
  shared: number;
  /** shared / sqrt(commits(a) * commits(b)), in (0, 1]. */
  score: number;
}

export interface CochangeIndex {
  /** False when there is no usable history; `reason` says why. Lookups then return nothing. */
  readonly available: boolean;
  readonly reason?: string;
  /** Commits counted (after skipping merges without a diff and oversized commits). */
  readonly commits: number;
  commitCount(path: string): number;
  /** Files that changed together with `path`, best score first. */
  neighbours(path: string, limit?: number): CochangeNeighbour[];
}

export function emptyCochange(reason: string): CochangeIndex {
  return { available: false, reason, commits: 0, commitCount: () => 0, neighbours: () => [] };
}

/** Marks the start of a commit in the log output; see LOG_ARGS. */
const COMMIT_MARK = '\u0001';
export const LOG_ARGS = ['log', '-M', '--name-status', `--format=${COMMIT_MARK}%H`, '--no-color'];

/**
 * Builds the index from `git log -M --name-status --format=<mark>%H` output (newest commit
 * first). Renames are followed: history under an old path counts for the path it has now.
 * `headFiles`, when given, limits the index to files that still exist.
 */
export function buildCochange(logText: string, headFiles?: Iterable<string>): CochangeIndex {
  const head = headFiles ? new Set(headFiles) : undefined;
  // old path -> the path the file has now. Filled while walking from new to old commits.
  const renamedTo = new Map<string, string>();
  const current = (p: string): string => {
    let name = p;
    for (let hops = 0; hops < 50; hops++) {
      const next = renamedTo.get(name);
      if (next === undefined || next === name) break;
      name = next;
    }
    return name;
  };

  const counts = new Map<string, number>();
  const pairs = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string): void => {
    let row = pairs.get(a);
    if (!row) pairs.set(a, (row = new Map()));
    row.set(b, (row.get(b) ?? 0) + 1);
  };
  let commits = 0;

  for (const block of logText.split(COMMIT_MARK)) {
    const lines = block.split(/\r?\n/).slice(1); // first line is the hash
    const files = new Set<string>();
    const renames: [string, string][] = [];
    for (const line of lines) {
      if (line === '') continue;
      const parts = line.split('\t');
      const status = parts[0] ?? '';
      if ((status.startsWith('R') || status.startsWith('C')) && parts.length >= 3) {
        const from = (parts[1] ?? '').replace(/\\/g, '/');
        const to = (parts[2] ?? '').replace(/\\/g, '/');
        files.add(current(to));
        if (status.startsWith('R')) renames.push([from, to]);
      } else if (parts.length >= 2) {
        files.add(current((parts[1] ?? '').replace(/\\/g, '/')));
      }
    }
    // Older commits name the file by its old path; record that even for skipped commits
    // (a big "move everything" commit is exactly where renames happen).
    for (const [from, to] of renames) {
      const now = current(to);
      if (from !== now) renamedTo.set(from, now);
    }
    const kept = [...files].filter((f) => !head || head.has(f));
    if (files.size === 0 || files.size > MAX_FILES_PER_COMMIT) continue;
    commits++;
    for (const f of kept) counts.set(f, (counts.get(f) ?? 0) + 1);
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        bump(kept[i]!, kept[j]!);
        bump(kept[j]!, kept[i]!);
      }
    }
  }

  if (commits === 0) return emptyCochange('no commits with file changes in the git history');
  return {
    available: true,
    commits,
    commitCount: (path) => counts.get(path) ?? 0,
    neighbours: (path, limit = 50) => {
      const own = counts.get(path) ?? 0;
      const row = pairs.get(path);
      if (!row || own === 0) return [];
      const out: CochangeNeighbour[] = [];
      for (const [other, shared] of row) {
        const theirs = counts.get(other) ?? 0;
        if (theirs > 0) out.push({ path: other, shared, score: shared / Math.sqrt(own * theirs) });
      }
      out.sort((a, b) => b.score - a.score || b.shared - a.shared || a.path.localeCompare(b.path));
      return out.slice(0, limit);
    },
  };
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024, windowsHide: true, encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

const cache = new Map<string, Promise<CochangeIndex>>();

/**
 * The co-change index of the git repository at `root`, mined once and cached for the
 * process. Never throws: with no git, no repository or a shallow clone it returns an index
 * with `available: false` and the retriever carries on without this signal.
 */
export function mineCochange(root: string): Promise<CochangeIndex> {
  let pending = cache.get(root);
  if (!pending) {
    pending = (async (): Promise<CochangeIndex> => {
      try {
        const shallow = (await git(root, ['rev-parse', '--is-shallow-repository'])).trim();
        if (shallow === 'true') return emptyCochange('shallow clone: the git history is incomplete');
        // core.quotepath=off keeps non-ASCII paths readable instead of octal-escaped.
        const [log, files] = await Promise.all([
          git(root, ['-c', 'core.quotepath=off', ...LOG_ARGS]),
          git(root, ['-c', 'core.quotepath=off', 'ls-files']),
        ]);
        return buildCochange(log, files.split(/\r?\n/).filter(Boolean));
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return emptyCochange(`no git history available (${text.split(/\r?\n/)[0]})`);
      }
    })();
    cache.set(root, pending);
  }
  return pending;
}

/** Forgets cached indexes (tests, or after the history changed). */
export function clearCochangeCache(): void {
  cache.clear();
}
