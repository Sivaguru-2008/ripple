// Line diff and text helpers for staged edits. No `vscode` imports.

/** A contiguous change: base lines [baseStart, baseEnd) become `newLines`. 0-based. */
export interface LineChange {
  baseStart: number;
  baseEnd: number;
  oldLines: string[];
  newLines: string[];
}

/** Largest middle section (lines × lines) diffed with LCS; beyond it the middle is one change. */
const MAX_LCS_CELLS = 4_000_000;

/** Splits text into lines without line terminators. `a\nb\n` → ['a', 'b', '']. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** The line terminator a text mostly uses. */
export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Line-level diff of `a` against `b`. Consecutive changed lines form one change;
 * changes never overlap and are returned in order.
 */
export function diffLines(a: string[], b: string[]): LineChange[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA.length === 0 && midB.length === 0) return [];
  if (midA.length * midB.length > MAX_LCS_CELLS || midA.length === 0 || midB.length === 0) {
    return [{ baseStart: prefix, baseEnd: prefix + midA.length, oldLines: midA, newLines: midB }];
  }

  // LCS table over the middle; walk it to emit runs of equal / changed lines.
  const n = midA.length;
  const m = midB.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => table[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] = midA[i] === midB[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const changes: LineChange[] = [];
  let open: LineChange | undefined;
  const close = (): void => {
    if (open) changes.push(open);
    open = undefined;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i >= n || at(i, j + 1) >= at(i + 1, j))) {
      open ??= { baseStart: prefix + i, baseEnd: prefix + i, oldLines: [], newLines: [] };
      open.newLines.push(midB[j] ?? '');
      j++;
    } else {
      open ??= { baseStart: prefix + i, baseEnd: prefix + i, oldLines: [], newLines: [] };
      open.oldLines.push(midA[i] ?? '');
      open.baseEnd = prefix + i + 1;
      i++;
    }
  }
  close();
  return changes;
}

/** Character offset of the start of each line in `text` (plus one past the end). */
export function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '\n') offsets.push(k + 1);
  }
  offsets.push(text.length);
  return offsets;
}

const GUTTER = /^\s*(\d+)(?: {2}|\t|: |\s?\|\s?)(.*)$/;

/**
 * Removes a line-number gutter copied from `read_file` output (`"12  code"`).
 * Only strips when every non-empty line carries a gutter and the numbers are
 * consecutive, so ordinary text that starts with a number is left alone.
 */
export function stripLineGutter(text: string): { text: string; stripped: boolean } {
  const lines = text.split('\n');
  const parsed: { n: number; rest: string; cr: boolean }[] = [];
  let expected: number | undefined;
  for (const raw of lines) {
    const cr = raw.endsWith('\r');
    const line = cr ? raw.slice(0, -1) : raw;
    if (line === '') {
      parsed.push({ n: Number.NaN, rest: '', cr });
      continue;
    }
    const match = GUTTER.exec(line);
    if (!match) return { text, stripped: false };
    const n = Number(match[1]);
    if (expected !== undefined && n !== expected) return { text, stripped: false };
    expected = n + 1;
    parsed.push({ n, rest: match[2] ?? '', cr });
  }
  if (expected === undefined) return { text, stripped: false };
  return { text: parsed.map((p) => p.rest + (p.cr ? '\r' : '')).join('\n'), stripped: true };
}

/**
 * Removes spaces and tabs at the end of each line of model-written text (small models add
 * whitespace-only lines). A line that already exists in `existing` with exactly that
 * text is kept as it is, so untouched lines produce no hunk. With `wholeLines: false` the last
 * line is left alone, because it may continue with text that follows it in the file.
 */
export function stripTrailingWhitespace(text: string, existing: string, wholeLines: boolean): string {
  const bare = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);
  const keep = new Set(existing.split('\n').map(bare));
  const lines = text.split('\n');
  return lines
    .map((raw, k) => {
      if (!wholeLines && k === lines.length - 1) return raw;
      const line = bare(raw);
      return keep.has(line) ? raw : line.replace(/[ \t]+$/, '') + raw.slice(line.length);
    })
    .join('\n');
}

/** Removes a single surrounding Markdown code fence, if the whole text is one. */
export function stripCodeFence(text: string): string {
  const match = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return match ? (match[1] ?? '') : text;
}
