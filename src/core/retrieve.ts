// Ripple retrieval (AGENTS.md section 3, part 2). No `vscode` imports.
//
// Seeds come from lexical and symbol search on the request plus anything the user pinned with
// an @mention. Seeds are expanded by git co-change, by test/doc name pairing and by import
// neighbours. The fused ranking is packed into a hard token budget, and the result carries a
// receipt: for every file why it is there, the evidence, its token cost, and what was cut.
import type { CochangeIndex } from './cochange';
import { withLineNumbers } from './paths';

export const DEFAULT_BUDGET_TOKENS = 8000;
export const MIN_BUDGET_TOKENS = 600;
const MAX_FILE_BYTES = 300_000;
const MAX_FILES_SCANNED = 4000;
const MAX_SEEDS = 3;
const MAX_CANDIDATES = 12;
const MAX_EVICTED_LISTED = 8;
const CHUNK_LINES = 40;

/** Where the retriever gets files from. The extension supplies it; tests use a map. */
export interface RetrieveSource {
  /** Workspace-relative paths with forward slashes. */
  listFiles(): Promise<string[]>;
  readText(path: string): Promise<string>;
}

/** A file (or a line range of it, 1-based inclusive) the user pinned with an @mention. */
export interface Pin {
  path: string;
  startLine?: number;
  endLine?: number;
  /** What the user typed, e.g. "@FlaskGroup". */
  label: string;
}

export type Reason = 'pinned' | 'lexical' | 'co-change' | 'pairing' | 'import';

export interface LineRange {
  start: number;
  end: number;
}

export interface PackedFile {
  path: string;
  mode: 'full' | 'excerpt';
  /** 1-based inclusive line ranges included. */
  ranges: LineRange[];
  totalLines: number;
  /** Included text with read_file style line numbers. */
  text: string;
  tokens: number;
}

export interface ReceiptRow {
  path: string;
  reason: Reason;
  evidence: string;
  tokens: number;
  mode: 'full' | 'excerpt';
  score: number;
}

export interface EvictedRow {
  path: string;
  /** Why the file was cut. */
  reason: string;
  /** Why it was a candidate at all. */
  evidence: string;
  score: number;
}

export interface RetrieveResult {
  task: string;
  budgetTokens: number;
  /** Estimated tokens of `text`; never more than `budgetTokens`. */
  usedTokens: number;
  files: PackedFile[];
  receipt: ReceiptRow[];
  evicted: EvictedRow[];
  /** Candidates that were cut but not listed individually. */
  evictedUnlisted: number;
  notes: string[];
  /** The receipt followed by the packed files: what the agent receives. */
  text: string;
}

export interface RetrieveOptions {
  budgetTokens?: number;
  pins?: Pin[];
  /** Omit (or pass an unavailable index) to run without the co-change signal. */
  cochange?: CochangeIndex;
}

/** Token estimate used for the budget. No tokenizer: Ripple must work with any model. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const STOPWORDS = new Set(
  ('a an and any are as at be been by can do does each every for from has have how if in into is it its must new no not of on ' +
    'or other our should so some such than that the their them then there these this those to up use used using was well were ' +
    'what when where which while will with would you your add adds make makes also all only just like need needs want').split(' '),
);

/** Crude stemmer: enough to match "commands" with "command" and "masking" with "mask". */
export function stem(word: string): string {
  let w = word.toLowerCase();
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'ed', 'es', 's']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

/** Words of a text: identifiers are split at `_`, `-`, `.` and camelCase humps. */
function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])/);
    for (const p of parts) if (p.length >= 2) out.push(stem(p));
  }
  return out;
}

/** Distinct query terms, in order, without stopwords. */
export function queryTerms(task: string): string[] {
  const seen = new Set<string>();
  for (const raw of task.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    for (const p of raw.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      const lower = p.toLowerCase();
      if (p.length < 2 || STOPWORDS.has(lower)) continue;
      seen.add(stem(p));
    }
  }
  return [...seen];
}

const DEF = /^(\s*)(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|static\s+|async\s+)*(?:def|class|function|interface|type|enum|struct|func|fn|const|let|var)\s+\*?\s*([A-Za-z_$][\w$]*)/;

export interface SymbolDef {
  name: string;
  /** 0-based line of the definition. */
  line: number;
  indent: number;
}

export function findSymbols(lines: string[]): SymbolDef[] {
  const out: SymbolDef[] = [];
  for (const [k, line] of lines.entries()) {
    const m = DEF.exec(line);
    if (m?.[2]) out.push({ name: m[2], line: k, indent: (m[1] ?? '').replace(/\t/g, '    ').length });
  }
  return out;
}

/** Lines [start, end) of the block that starts at a definition, by indentation. 0-based. */
export function symbolBlock(lines: string[], def: SymbolDef): { start: number; end: number } {
  // Decorators and comments directly above belong to the definition.
  let start = def.line;
  while (start > 0 && /^\s*(@|#|\/\/|\/\*|\*)/.test(lines[start - 1] ?? '')) start--;
  let end = def.line + 1;
  for (; end < lines.length; end++) {
    const line = lines[end] ?? '';
    if (line.trim() === '') continue;
    const indent = (/^\s*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
    if (indent > def.indent) continue;
    // A closing bracket at the definition's indentation still belongs to it.
    if (indent === def.indent && /^\s*[)\]}]/.test(line)) continue;
    break;
  }
  while (end > def.line + 1 && (lines[end - 1] ?? '').trim() === '') end--;
  return { start, end };
}

interface Doc {
  path: string;
  text: string;
  lines: string[];
  tf: Map<string, number>;
  length: number;
  pathWords: Set<string>;
  /** Words of the file name without directories. */
  nameWords: Set<string>;
  symbols: SymbolDef[];
}

function stemOfFile(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.indexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs)\//i;
const DOC_FILE = /\.(rst|md|mdx|txt|adoc)$/i;

function isTestPath(path: string): boolean {
  const s = stemOfFile(path);
  return TEST_DIR.test(path) || s.startsWith('test_') || s.endsWith('_test') || /\.(test|spec)\.[a-z]+$/i.test(path);
}

/** The name a test or doc file is "about": test_cli.py → cli, cli.test.ts → cli, docs/cli.rst → cli. */
function subjectOf(path: string): string {
  return stemOfFile(path).replace(/^test_/, '').replace(/_test$/, '');
}

/** Module specifiers a file imports, resolved to workspace files. */
function importsOf(doc: Doc, files: Set<string>, byModule: Map<string, string[]>): string[] {
  const dir = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : '';
  const found = new Set<string>();
  const add = (p: string | undefined): void => {
    if (p && p !== doc.path && files.has(p)) found.add(p);
  };
  const join = (base: string, rel: string): string => {
    const parts = (base ? base.split('/') : []).concat(rel.split('/'));
    const out: string[] = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return out.join('/');
  };
  const pyModule = (mod: string): void => {
    add(`${mod}.py`);
    add(`${mod}/__init__.py`);
  };
  if (doc.path.endsWith('.py')) {
    for (const line of doc.lines) {
      const from = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(line);
      if (from) {
        const dots = from[1] ?? '';
        const mod = (from[2] ?? '').replace(/\./g, '/');
        const names = (from[3] ?? '').replace(/[()]/g, '').split(',').map((n) => n.trim().split(/\s+as\s+/)[0] ?? '');
        if (dots) {
          const base = join(dir, '../'.repeat(dots.length - 1));
          const target = mod ? join(base, mod) : base;
          pyModule(target);
          for (const n of names) if (/^\w+$/.test(n)) pyModule(join(target, n));
        } else if (mod) {
          for (const p of byModule.get(mod) ?? []) add(p);
          for (const n of names) if (/^\w+$/.test(n)) for (const p of byModule.get(`${mod}/${n}`) ?? []) add(p);
        }
        continue;
      }
      const plain = /^\s*import\s+([\w.]+)/.exec(line);
      if (plain?.[1]) for (const p of byModule.get(plain[1].replace(/\./g, '/')) ?? []) add(p);
    }
  } else if (/\.(m?[jt]sx?|cjs)$/.test(doc.path)) {
    const re = /(?:from\s+|require\(\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
    for (let m = re.exec(doc.text); m; m = re.exec(doc.text)) {
      const target = join(dir, m[1] ?? '');
      for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.js']) add(target + ext);
    }
  }
  return [...found];
}

interface Candidate {
  path: string;
  lexical: number;
  cochange: number;
  pairing: number;
  imports: number;
  /** Set for seeds: the files the expansion started from must not rank below what they pulled in. */
  seed: number;
  pinned: Pin[];
  evidence: Partial<Record<Reason, string>>;
}

function total(c: Candidate): number {
  return c.lexical + c.seed + c.cochange + 0.8 * c.pairing + 0.4 * c.imports;
}

function mainReason(c: Candidate): Reason {
  if (c.pinned.length) return 'pinned';
  const parts: [Reason, number][] = [
    ['lexical', c.lexical + c.seed],
    ['co-change', c.cochange],
    ['pairing', 0.8 * c.pairing],
    ['import', 0.4 * c.imports],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  return parts[0]?.[0] ?? 'lexical';
}

function evidenceText(c: Candidate): string {
  const order: Reason[] = ['pinned', 'lexical', 'co-change', 'pairing', 'import'];
  const main = mainReason(c);
  const rest = order.filter((r) => r !== main && c.evidence[r]);
  return [c.evidence[main], ...rest.map((r) => c.evidence[r])].filter(Boolean).join('; ');
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: LineRange[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

function renderRanges(doc: Doc, ranges: LineRange[]): string {
  return ranges.map((r) => withLineNumbers(doc.text, r.start, r.end)).join('\n   ...\n');
}

function fileHeader(doc: Doc, mode: 'full' | 'excerpt', ranges: LineRange[]): string {
  const where =
    mode === 'full'
      ? `full file, ${doc.lines.length} lines`
      : `excerpt: lines ${ranges.map((r) => `${r.start}-${r.end}`).join(', ')} of ${doc.lines.length}`;
  return `=== ${doc.path} (${where}) ===`;
}

/** Picks the parts of a file most relevant to the request that fit `cap` tokens. */
function excerpt(doc: Doc, terms: string[], idf: Map<string, number>, cap: number, required: LineRange[]): LineRange[] {
  // Chunks: blocks that start at a definition, long stretches cut every CHUNK_LINES lines.
  const starts = new Set<number>([0]);
  for (const s of doc.symbols) if (s.indent <= 4) starts.add(symbolBlock(doc.lines, s).start);
  const sorted = [...starts].sort((a, b) => a - b);
  const chunks: { start: number; end: number; score: number }[] = [];
  for (const [k, start] of sorted.entries()) {
    const stop = sorted[k + 1] ?? doc.lines.length;
    for (let at = start; at < stop; at += CHUNK_LINES) chunks.push({ start: at, end: Math.min(stop, at + CHUNK_LINES), score: 0 });
  }
  for (const c of chunks) {
    const seen = new Map<string, number>();
    for (const w of words(doc.lines.slice(c.start, c.end).join('\n'))) seen.set(w, (seen.get(w) ?? 0) + 1);
    for (const t of terms) c.score += (idf.get(t) ?? 0) * Math.min(seen.get(t) ?? 0, 3);
  }
  const cost = (ranges: LineRange[]): number => estimateTokens(`${fileHeader(doc, 'excerpt', ranges)}\n${renderRanges(doc, ranges)}\n`);
  let chosen: LineRange[] = mergeRanges(required);
  if (chosen.length && cost(chosen) > cap) {
    // Even the pinned range is too big: keep its start.
    const first = chosen[0]!;
    let end = first.end;
    while (end > first.start && cost([{ start: first.start, end }]) > cap) end = first.start + Math.floor((end - first.start) / 2);
    return [{ start: first.start, end }];
  }
  const ranked = chunks.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.start - b.start);
  // Nothing matches the request (e.g. a file found by pairing only): show how it starts.
  if (ranked.length === 0 && chosen.length === 0) ranked.push(...chunks.slice(0, 3));
  for (const c of ranked) {
    const next = mergeRanges([...chosen, { start: c.start + 1, end: c.end }]);
    if (cost(next) <= cap) chosen = next;
  }
  if (chosen.length === 0 && chunks[0]) {
    let end = chunks[0].end;
    while (end > 1 && cost([{ start: 1, end }]) > cap) end = Math.floor(end / 2);
    if (cost([{ start: 1, end }]) <= cap) chosen = [{ start: 1, end }];
  }
  return chosen;
}

function render(result: Omit<RetrieveResult, 'text' | 'usedTokens'>): string {
  const out: string[] = [];
  out.push(`Context for: ${result.task.replace(/\s+/g, ' ').slice(0, 160)}`);
  out.push(`Budget ${result.budgetTokens} tokens (estimated as characters / 4).`);
  out.push('Receipt: why each file is included');
  for (const r of result.receipt) out.push(`- ${r.path} [${r.mode}, ~${r.tokens} tokens] ${r.reason}: ${r.evidence}`);
  if (result.evicted.length) {
    out.push('Evicted: candidates left out (use read_file if you need them)');
    for (const e of result.evicted) out.push(`- ${e.path}: ${e.reason} (${e.evidence})`);
    if (result.evictedUnlisted) out.push(`- and ${result.evictedUnlisted} lower-ranked file(s)`);
  }
  for (const n of result.notes) out.push(`Note: ${n}`);
  out.push('Excerpts show line numbers that are not part of the files. Use read_file for anything not shown.');
  for (const f of result.files) out.push('', f.text.trimEnd());
  return out.join('\n');
}

async function loadDocs(source: RetrieveSource, wanted: (path: string) => boolean): Promise<Doc[]> {
  const paths = (await source.listFiles()).map((p) => p.replace(/\\/g, '/')).filter(wanted).slice(0, MAX_FILES_SCANNED);
  const docs: Doc[] = [];
  const BATCH = 32;
  for (let k = 0; k < paths.length; k += BATCH) {
    const batch = await Promise.all(
      paths.slice(k, k + BATCH).map(async (path): Promise<Doc | undefined> => {
        let text: string;
        try {
          text = await source.readText(path);
        } catch {
          return undefined;
        }
        if (text.length > MAX_FILE_BYTES || text.includes('\u0000')) return undefined;
        const lines = text.split(/\r?\n/);
        const tf = new Map<string, number>();
        const all = words(text);
        for (const w of all) tf.set(w, (tf.get(w) ?? 0) + 1);
        return { path, text, lines, tf, length: all.length, pathWords: new Set(words(path)), nameWords: new Set(words(path.slice(path.lastIndexOf('/') + 1))), symbols: findSymbols(lines) };
      }),
    );
    for (const d of batch) if (d) docs.push(d);
  }
  return docs;
}

const SKIP = /(^|\/)(node_modules|\.git|dist|build|out|\.venv|venv|__pycache__|\.tox|\.mypy_cache|\.pytest_cache)\/|\.(png|jpe?g|gif|ico|svg|pdf|zip|gz|woff2?|ttf|eot|lock|min\.js|map|pyc)$|(^|\/)package-lock\.json$/i;

/** Ranks workspace files for a task and packs them into the token budget, with a receipt. */
export async function retrieve(task: string, source: RetrieveSource, options: RetrieveOptions = {}): Promise<RetrieveResult> {
  const budget = Math.max(MIN_BUDGET_TOKENS, Math.floor(options.budgetTokens ?? DEFAULT_BUDGET_TOKENS));
  const pins = options.pins ?? [];
  const notes: string[] = [];
  const docs = await loadDocs(source, (p) => !SKIP.test(p) || pins.some((pin) => pin.path === p));
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const files = new Set(byPath.keys());
  const terms = queryTerms(task);

  // ---- Lexical and symbol search (BM25 over file text, plus path and symbol-name matches).
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, docs.filter((d) => d.tf.has(t) || d.pathWords.has(t)).length);
  const idf = new Map<string, number>();
  for (const t of terms) idf.set(t, Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5)));
  const avgLength = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const lexical = new Map<string, { score: number; evidence: string }>();
  for (const d of docs) {
    const hits: { term: string; score: number; note: string }[] = [];
    for (const t of terms) {
      const tf = d.tf.get(t) ?? 0;
      const w = idf.get(t) ?? 0;
      // BM25 with weak length normalisation: a long file is not less relevant for being long.
      let score = tf ? (w * tf * 2.2) / (tf + 1.2 * (0.8 + 0.2 * (d.length / Math.max(1, avgLength)))) : 0;
      let note = tf ? `'${t}' ×${tf}` : '';
      const symbol = d.symbols.find((s) => words(s.name).includes(t));
      if (symbol) {
        score += w;
        note = `'${t}' ×${tf} (defines ${symbol.name})`;
      }
      if (d.nameWords.has(t)) {
        score += 4 * w;
        note = `'${t}' in the file name${tf ? ` and ×${tf}` : ''}`;
      } else if (d.pathWords.has(t)) {
        score += w;
        if (!tf) note = `'${t}' in the path`;
      }
      if (score > 0) hits.push({ term: t, score, note });
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => b.score - a.score);
    // Tests and docs repeat the words of the code they describe; the code itself leads.
    const weight = isTestPath(d.path) || DOC_FILE.test(d.path) ? 0.85 : 1;
    lexical.set(d.path, {
      score: weight * hits.reduce((n, h) => n + h.score, 0),
      evidence: `matches ${hits.slice(0, 3).map((h) => h.note).join(', ')}`,
    });
  }
  const topLexical = Math.max(0, ...[...lexical.values()].map((v) => v.score));

  const candidates = new Map<string, Candidate>();
  const cand = (path: string): Candidate => {
    let c = candidates.get(path);
    if (!c) candidates.set(path, (c = { path, lexical: 0, cochange: 0, pairing: 0, imports: 0, seed: 0, pinned: [], evidence: {} }));
    return c;
  };
  for (const [path, v] of lexical) {
    const c = cand(path);
    c.lexical = topLexical ? v.score / topLexical : 0;
    c.evidence.lexical = v.evidence;
  }
  for (const pin of pins) {
    if (!byPath.has(pin.path)) {
      notes.push(`pinned ${pin.label} could not be read (${pin.path})`);
      continue;
    }
    const c = cand(pin.path);
    c.pinned.push(pin);
    c.evidence.pinned = `pinned by the user with ${[...new Set(c.pinned.map((p) => p.label))].join(', ')}`;
  }

  // ---- Seeds: pinned files, then the best lexical matches.
  const seeds = new Map<string, number>();
  for (const c of candidates.values()) if (c.pinned.length) seeds.set(c.path, 1);
  for (const c of [...candidates.values()].sort((a, b) => b.lexical - a.lexical)) {
    if (seeds.size >= MAX_SEEDS + pins.length || c.lexical < 0.6) break;
    if (!seeds.has(c.path)) seeds.set(c.path, c.lexical);
  }
  for (const [path, weight] of seeds) cand(path).seed = weight;

  // ---- Expansion 1: co-change in git history.
  const co = options.cochange;
  if (!co) notes.push('co-change signal disabled');
  else if (!co.available) notes.push(`co-change signal unavailable: ${co.reason ?? 'no git history'}`);
  else {
    for (const [seed, weight] of seeds) {
      for (const n of co.neighbours(seed, 15)) {
        if (n.shared < 2 || !files.has(n.path) || n.path === seed) continue;
        const score = weight * Math.sqrt(n.score);
        const c = cand(n.path);
        if (score > c.cochange) {
          c.cochange = score;
          c.evidence['co-change'] = `changed with ${seed} in ${n.shared} commits (strength ${n.score.toFixed(2)})`;
        }
      }
    }
  }

  // ---- Expansion 2: test and doc files paired with a seed by name, and the reverse.
  for (const [seed, weight] of seeds) {
    const subject = subjectOf(seed);
    if (subject.length < 2 || subject === 'index' || subject === '__init__') continue;
    const seedIsSource = !isTestPath(seed) && !DOC_FILE.test(seed);
    for (const d of docs) {
      if (d.path === seed || subjectOf(d.path) !== subject) continue;
      const kind = isTestPath(d.path) ? 'test file' : DOC_FILE.test(d.path) ? 'documentation' : seedIsSource ? undefined : 'source file';
      if (!kind) continue;
      const c = cand(d.path);
      if (weight > c.pairing) {
        c.pairing = weight;
        c.evidence.pairing = `${kind} paired with ${seed} by name`;
      }
    }
  }

  // ---- Expansion 3: import neighbours of the seeds, both directions.
  const byModule = new Map<string, string[]>();
  for (const p of files) {
    if (!p.endsWith('.py')) continue;
    const mod = p.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/');
    for (let k = 0; k < mod.length; k++) {
      const key = mod.slice(k).join('/');
      byModule.set(key, [...(byModule.get(key) ?? []), p]);
    }
  }
  const importCache = new Map<string, string[]>();
  const imports = (d: Doc): string[] => {
    let v = importCache.get(d.path);
    if (!v) importCache.set(d.path, (v = importsOf(d, files, byModule)));
    return v;
  };
  for (const [seed, weight] of seeds) {
    const seedDoc = byPath.get(seed);
    if (!seedDoc) continue;
    for (const target of imports(seedDoc)) {
      const c = cand(target);
      if (weight > c.imports) {
        c.imports = weight;
        c.evidence.import = `imported by ${seed}`;
      }
    }
    for (const d of docs) {
      if (d.path === seed || !/\.(py|m?[jt]sx?|cjs)$/.test(d.path) || !imports(d).includes(seed)) continue;
      const c = cand(d.path);
      if (weight * 0.6 > c.imports) {
        c.imports = weight * 0.6;
        c.evidence.import = `imports ${seed}`;
      }
    }
  }

  // ---- Rank, then pack into the budget.
  const ranked = [...candidates.values()].sort(
    (a, b) => Number(b.pinned.length > 0) - Number(a.pinned.length > 0) || total(b) - total(a) || a.path.localeCompare(b.path),
  );
  const pinnedCount = ranked.filter((c) => c.pinned.length).length;
  const considered = ranked.slice(0, Math.max(MAX_CANDIDATES, pinnedCount));
  const best = total(considered.find((c) => !c.pinned.length) ?? considered[0] ?? cand(''));

  const packed: PackedFile[] = [];
  const receipt: ReceiptRow[] = [];
  const evicted: EvictedRow[] = [];
  const evict = (c: Candidate, why: string): void => {
    evicted.push({ path: c.path, reason: why, evidence: c.evidence[mainReason(c)] ?? evidenceText(c), score: total(c) });
  };
  // Room for the receipt itself, so the whole tool result stays inside the budget.
  const overhead = 110 + 70 * Math.min(considered.length, 6 + pinnedCount) + 45 * MAX_EVICTED_LISTED;
  let remaining = Math.max(0, budget - overhead);
  const fullCap = Math.floor(budget * 0.3);
  const excerptCap = Math.floor(budget * 0.17);
  let pinsLeft = pinnedCount;

  for (const c of considered) {
    const doc = byPath.get(c.path);
    if (!doc) continue;
    const isPinned = c.pinned.length > 0;
    if (!isPinned && total(c) < 0.15 * best) {
      evict(c, 'relevance too low compared with the best match');
      continue;
    }
    const fullRange = [{ start: 1, end: doc.lines.length }];
    const fullText = `${fileHeader(doc, 'full', fullRange)}\n${withLineNumbers(doc.text)}\n`;
    const fullTokens = estimateTokens(fullText);
    // A pinned file gets an equal share of what is left; it is shortened, never dropped.
    const share = isPinned ? Math.floor(remaining / Math.max(1, pinsLeft)) : remaining;
    if (isPinned) pinsLeft--;
    const wholeFilePinned = isPinned && c.pinned.some((p) => p.startLine === undefined);
    const mayBeFull = isPinned ? wholeFilePinned || fullTokens <= share : fullTokens <= fullCap;
    let file: PackedFile | undefined;
    if (mayBeFull && fullTokens <= share) {
      file = { path: doc.path, mode: 'full', ranges: fullRange, totalLines: doc.lines.length, text: fullText, tokens: fullTokens };
    } else {
      const cap = isPinned ? share : Math.min(share, excerptCap);
      const required = c.pinned
        .filter((p) => p.startLine !== undefined)
        .map((p) => ({ start: p.startLine ?? 1, end: Math.min(doc.lines.length, p.endLine ?? p.startLine ?? 1) }));
      const ranges = cap >= 60 ? excerpt(doc, terms, idf, cap, required) : [];
      if (ranges.length) {
        const text = `${fileHeader(doc, 'excerpt', ranges)}\n${renderRanges(doc, ranges)}\n`;
        const tokens = estimateTokens(text);
        if (tokens <= share) file = { path: doc.path, mode: 'excerpt', ranges, totalLines: doc.lines.length, text, tokens };
      }
    }
    if (!file) {
      if (isPinned) {
        // No room for any of its text: keep the row so the agent still knows to read it.
        const text = `${fileHeader(doc, 'excerpt', [])}\n(no room in the budget: read it with read_file)\n`;
        file = { path: doc.path, mode: 'excerpt', ranges: [], totalLines: doc.lines.length, text, tokens: estimateTokens(text) };
      } else {
        evict(c, `over budget: full file ~${fullTokens} tokens, ${remaining} left`);
        continue;
      }
    }
    remaining = Math.max(0, remaining - file.tokens);
    packed.push(file);
    receipt.push({ path: c.path, reason: mainReason(c), evidence: evidenceText(c), tokens: file.tokens, mode: file.mode, score: total(c) });
  }
  for (const c of ranked.slice(considered.length)) evict(c, `ranked below the top ${MAX_CANDIDATES} candidates`);
  evicted.sort((a, b) => b.score - a.score);

  const result: Omit<RetrieveResult, 'text' | 'usedTokens'> = {
    task,
    budgetTokens: budget,
    files: packed,
    receipt,
    evicted: evicted.slice(0, MAX_EVICTED_LISTED),
    evictedUnlisted: Math.max(0, evicted.length - MAX_EVICTED_LISTED),
    notes,
  };
  if (receipt.length === 0) notes.push('no file matched the request; use search_workspace');
  let text = render(result);
  // Hard guarantee. Drop the lowest-ranked unpinned file, then trim, until it fits.
  while (estimateTokens(text) > budget) {
    let k = result.files.length - 1;
    while (k >= 0 && result.receipt[k]?.reason === 'pinned') k--;
    if (k < 0) break;
    const [gone] = result.receipt.splice(k, 1);
    result.files.splice(k, 1);
    if (gone) result.evicted.unshift({ path: gone.path, reason: 'over budget after the receipt was added', evidence: gone.evidence, score: gone.score });
    text = render(result);
  }
  if (estimateTokens(text) > budget) text = `${text.slice(0, budget * 4 - 40)}\n[cut to fit the budget]`;
  return { ...result, usedTokens: estimateTokens(text), text };
}
