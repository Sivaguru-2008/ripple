// Fenced edit transactions (AGENTS.md section 3, part 1). No `vscode` imports.
//
// A run is created by the extension, never by the model. Every tool call is bound to a
// run through a per-run token in the MCP URL; calls from a finished, cancelled or unknown
// run are rejected and change nothing. Edits are staged as hunks, reviewed one by one,
// and the accepted hunks are applied together as one editor edit (one undo step).
import { createHash, randomBytes } from 'node:crypto';
import { detectEol, diffLines, lineOffsets, splitLines, stripCodeFence, stripLineGutter, stripTrailingWhitespace } from './diff';

export type RunState = 'active' | 'finished' | 'cancelled' | 'failed';

/** Lines [startLine, endLine) of `path` that an inline edit replaces. 0-based. */
export interface SelectionTarget {
  path: string;
  startLine: number;
  endLine: number;
  /** Text of those lines when the run started, joined with '\n'. */
  text: string;
}

export interface Run {
  readonly id: string;
  /** Secret placed in the MCP URL for this run only. */
  readonly token: string;
  state: RunState;
  readonly selection?: SelectionTarget;
}

export type HunkStatus = 'pending' | 'accepted' | 'rejected' | 'applied' | 'failed';

export interface Hunk {
  /** hash(base text, range, new text): identical proposals get identical ids. */
  readonly id: string;
  /** Base lines [baseStart, baseEnd) are replaced by newLines. 0-based. */
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly oldLines: string[];
  readonly newLines: string[];
  status: HunkStatus;
  reason?: string;
}

export type ProposalState = 'reviewing' | 'decided' | 'applied' | 'rejected' | 'failed' | 'discarded';

export interface Proposal {
  readonly id: string;
  readonly runId: string;
  readonly tool: string;
  readonly path: string;
  readonly baseText: string;
  readonly hunks: Hunk[];
  /** hash(tool, arguments): recognises the same call made twice. */
  readonly key: string;
  state: ProposalState;
  /** Set once the matching tool call has run (or was denied), so a repeat is a duplicate. */
  executed: boolean;
}

/** One replacement in the base text, by character offset. */
export interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

/** What the transaction manager needs from the editor. The extension supplies it. */
export interface EditorHost {
  /** Current text of a workspace file: the open buffer if any, else disk. */
  readText(path: string): Promise<string>;
  /**
   * Applies all replacements as ONE edit (one undo step) and saves, but only if the
   * file still equals `baseText`. Returns 'changed' and writes nothing otherwise.
   */
  applyEdits(path: string, baseText: string, edits: TextReplacement[]): Promise<'ok' | 'changed'>;
  /** Shows the review. Resolves when every hunk is decided or the review is closed. */
  review(proposal: Proposal): Promise<void>;
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

export type ApprovalAnswer = { allow: true } | { allow: false; reason: string };

export interface AppliedChange {
  runId: string;
  path: string;
  before: string;
  after: string;
}

export class StaleRunError extends Error {}

export interface ProposeWriteArgs {
  path: string;
  edits: { old_text: string; new_text: string }[];
}

export interface ReplaceSelectionArgs {
  new_text: string;
}

const STATUS_STAGED = 'staged, awaiting review';
const STATUS_APPLIED = 'applied';
const rejectedStatus = (reason: string | undefined): string => `rejected by user: ${reason ?? 'no reason given'}`;

function sha(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\u0000');
  return h.digest('hex').slice(0, 12);
}

function describeLines(h: Hunk): string {
  const first = h.baseStart + 1;
  const last = h.baseEnd;
  if (last < first) return `insert before line ${first}`;
  return first === last ? `line ${first}` : `lines ${first}-${last}`;
}

function hunkStatusText(h: Hunk): string {
  switch (h.status) {
    case 'pending':
    case 'accepted':
      return STATUS_STAGED;
    case 'applied':
      return STATUS_APPLIED;
    case 'rejected':
      return rejectedStatus(h.reason);
    case 'failed':
      return `not applied: ${h.reason ?? 'failed'}`;
  }
}

type StageResult = { kind: 'staged' | 'duplicate'; proposal: Proposal } | { kind: 'error'; error: string };

/** Builds the base→new text for a tool call, or explains why the call is invalid. */
type Target = { ok: true; path: string; baseText: string; newText: string } | { ok: false; error: string };

export class TransactionManager {
  private readonly runs = new Map<string, Run>();
  private readonly byToken = new Map<string, Run>();
  private readonly proposals: Proposal[] = [];
  private readonly reviews = new Map<string, () => void>();
  private readonly staging = new Map<string, Promise<void>>();
  private nextRun = 1;
  private nextProposal = 1;
  lastApplied: AppliedChange | undefined;

  constructor(private readonly host: EditorHost) {}

  beginRun(selection?: SelectionTarget): Run {
    const run: Run = {
      id: `run-${this.nextRun++}`,
      token: randomBytes(16).toString('base64url'),
      state: 'active',
      ...(selection ? { selection } : {}),
    };
    this.runs.set(run.id, run);
    this.byToken.set(run.token, run);
    return run;
  }

  getRun(id: string): Run | undefined {
    return this.runs.get(id);
  }

  activeRun(): Run | undefined {
    return [...this.runs.values()].find((r) => r.state === 'active');
  }

  /** The active run a token belongs to; throws StaleRunError for anything else. */
  requireActive(token: string): Run {
    const run = this.byToken.get(token);
    if (!run) throw new StaleRunError('Rejected: this tool call does not belong to any Ripple run. Nothing was changed.');
    if (run.state !== 'active') {
      throw new StaleRunError(`Rejected: ${run.id} is ${run.state}; its tool calls are no longer accepted. Nothing was changed.`);
    }
    return run;
  }

  /** Ends a run. Cancel or failure discards everything it staged and closes its reviews. */
  endRun(id: string, state: Exclude<RunState, 'active'>): void {
    const run = this.runs.get(id);
    if (!run || run.state !== 'active') return;
    run.state = state;
    for (const p of this.proposals) {
      if (p.runId !== id) continue;
      if (p.state === 'reviewing' || p.state === 'decided') {
        p.state = 'discarded';
        for (const h of p.hunks) {
          if (h.status === 'pending' || h.status === 'accepted') {
            h.status = 'failed';
            h.reason = `run ${state}, nothing written`;
          }
        }
      }
      this.reviews.get(p.id)?.();
      this.reviews.delete(p.id);
    }
  }

  proposalsFor(runId: string): Proposal[] {
    return this.proposals.filter((p) => p.runId === runId);
  }

  getProposal(id: string): Proposal | undefined {
    return this.proposals.find((p) => p.id === id);
  }

  /** Records the user's decision on one hunk. Resolves the review once all are decided. */
  decide(proposalId: string, hunkId: string, accept: boolean, reason?: string): void {
    const p = this.getProposal(proposalId);
    if (!p || p.state !== 'reviewing') return;
    const h = p.hunks.find((x) => x.id === hunkId);
    if (!h || h.status !== 'pending') return;
    h.status = accept ? 'accepted' : 'rejected';
    if (!accept) h.reason = reason?.trim() || 'no reason given';
    if (p.hunks.every((x) => x.status !== 'pending')) {
      p.state = 'decided';
      this.reviews.get(p.id)?.();
      this.reviews.delete(p.id);
    }
  }

  /**
   * Called on the TrueForge approval pause. Stages the call's hunks, opens the review and
   * turns the user's per-hunk decisions into the approval answer. Calls that would write
   * nothing (invalid, duplicate) are allowed so the tool can explain the problem itself.
   */
  async reviewForApproval(runId: string, tool: string, rawArgs: unknown): Promise<ApprovalAnswer> {
    const run = this.runs.get(runId);
    if (!run || run.state !== 'active') return { allow: false, reason: 'the run has ended; nothing was written' };
    const staged = await this.stage(run, tool, rawArgs);
    if (staged.kind !== 'staged') return { allow: true };
    const p = staged.proposal;
    await this.awaitReview(p);
    this.closeUndecided(p);
    if (run.state !== 'active' || p.state === 'discarded') {
      return { allow: false, reason: `run ${run.state}; nothing was written` };
    }
    if (p.hunks.some((h) => h.status === 'accepted')) return { allow: true };
    p.state = 'rejected';
    p.executed = true;
    const reasons = p.hunks.map((h) => `hunk ${h.id} (${describeLines(h)}): ${rejectedStatus(h.reason)}`);
    return { allow: false, reason: `${reasons.join('; ')}. Nothing was written to ${p.path}.` };
  }

  /** Called by the MCP tool handler. Applies the reviewed hunks of this call, if any. */
  async execute(token: string, tool: string, rawArgs: unknown): Promise<ToolOutcome> {
    let run: Run;
    try {
      run = this.requireActive(token);
    } catch (err) {
      return { isError: true, text: (err as Error).message };
    }
    const staged = await this.stage(run, tool, rawArgs);
    if (staged.kind === 'error') return { isError: true, text: staged.error };
    const p = staged.proposal;
    if (staged.kind === 'duplicate' && (p.executed || p.state === 'reviewing')) {
      const what = p.state === 'reviewing' ? 'already staged, awaiting review' : `already ${p.state}`;
      return { isError: false, text: `${what}: this exact edit to ${p.path} was proposed before in this run (proposal ${p.id}). Nothing new was staged.\n${this.report(p)}` };
    }
    if (p.state === 'reviewing') await this.awaitReview(p);
    this.closeUndecided(p);
    if (run.state !== 'active' || p.state === 'discarded') {
      return { isError: true, text: `Rejected: ${run.id} is ${run.state}. Nothing was written.` };
    }
    return this.applyDecided(p);
  }

  /** A review closed early: hunks left undecided count as rejected. */
  private closeUndecided(p: Proposal): void {
    if (p.state !== 'reviewing') return;
    for (const h of p.hunks) {
      if (h.status === 'pending') {
        h.status = 'rejected';
        h.reason = 'review closed without a decision';
      }
    }
    p.state = 'decided';
  }

  private awaitReview(p: Proposal): Promise<void> {
    if (p.state !== 'reviewing') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const previous = this.reviews.get(p.id);
      this.reviews.set(p.id, () => {
        previous?.();
        resolve();
      });
      // The host's promise resolving (e.g. review tab closed) also ends the wait.
      if (!previous) {
        void this.host.review(p).then(() => {
          this.reviews.get(p.id)?.();
          this.reviews.delete(p.id);
        });
      }
    });
  }

  private async applyDecided(p: Proposal): Promise<ToolOutcome> {
    p.executed = true;
    const accepted = p.hunks.filter((h) => h.status === 'accepted');
    if (accepted.length === 0) {
      p.state = 'rejected';
      return { isError: false, text: this.report(p) };
    }
    const offsets = lineOffsets(p.baseText);
    const eol = detectEol(p.baseText);
    const lineCount = splitLines(p.baseText).length;
    const edits: TextReplacement[] = accepted.map((h) => {
      const start = offsets[h.baseStart] ?? p.baseText.length;
      const replacingToEnd = h.baseEnd >= lineCount;
      const end = replacingToEnd ? p.baseText.length : (offsets[h.baseEnd] ?? p.baseText.length);
      let text = h.newLines.join(eol);
      if (h.newLines.length > 0 && !replacingToEnd) text += eol;
      // Deleting the last lines: also drop the line break before them.
      if (h.newLines.length === 0 && replacingToEnd && start > 0) {
        return { start: start - (p.baseText.slice(0, start).endsWith('\r\n') ? 2 : 1), end, text };
      }
      return { start, end, text };
    });
    const result = await this.host.applyEdits(p.path, p.baseText, edits);
    if (result === 'changed') {
      p.state = 'failed';
      for (const h of accepted) {
        h.status = 'failed';
        h.reason = 'the file changed after the edit was staged; read it again and re-propose';
      }
      return { isError: true, text: this.report(p) };
    }
    p.state = 'applied';
    for (const h of accepted) h.status = 'applied';
    let after = p.baseText;
    for (const e of [...edits].sort((a, b) => b.start - a.start)) after = after.slice(0, e.start) + e.text + after.slice(e.end);
    this.lastApplied = { runId: p.runId, path: p.path, before: p.baseText, after };
    return { isError: false, text: this.report(p) };
  }

  /** Precise per-hunk status text for the model. Never implies a write that did not happen. */
  report(p: Proposal): string {
    const lines = p.hunks.map((h) => `- hunk ${h.id} (${describeLines(h)}): ${hunkStatusText(h)}`);
    const applied = p.hunks.filter((h) => h.status === 'applied').length;
    const tail =
      applied === 0
        ? `Nothing was written to ${p.path}.`
        : `${applied} of ${p.hunks.length} hunk(s) were written to ${p.path}; the others were not.`;
    return `${p.tool} ${p.path} (proposal ${p.id}):\n${lines.join('\n')}\n${tail}`;
  }

  /** Validates a call, computes its hunks and stages them (or finds the earlier identical proposal). */
  private stage(run: Run, tool: string, rawArgs: unknown): Promise<StageResult> {
    // Staging reads the file asynchronously; serialise per run so two identical calls
    // arriving together cannot both stage.
    const previous = this.staging.get(run.id) ?? Promise.resolve();
    const next = previous.then(() => this.stageNow(run, tool, rawArgs));
    this.staging.set(run.id, next.then(() => undefined, () => undefined));
    return next;
  }

  private async stageNow(run: Run, tool: string, rawArgs: unknown): Promise<StageResult> {
    // The same call again (e.g. after it was applied, when old_text no longer matches).
    const key = sha(tool, JSON.stringify(rawArgs ?? null));
    const mine = this.proposals.filter((p) => p.runId === run.id && p.state !== 'discarded');
    const sameCall = mine.find((p) => p.key === key);
    if (sameCall) return { kind: 'duplicate', proposal: sameCall };
    const target = await this.target(run, tool, rawArgs);
    if (!target.ok) return { kind: 'error', error: target.error };

    const changes = diffLines(splitLines(target.baseText), splitLines(target.newText));
    if (changes.length === 0) {
      return { kind: 'error', error: `No change: the proposed text for ${target.path} is identical to the current text. Nothing was staged.` };
    }
    const hunks: Hunk[] = changes.map((c) => ({
      id: sha(target.baseText, `${c.baseStart}:${c.baseEnd}`, c.newLines.join('\n')),
      baseStart: c.baseStart,
      baseEnd: c.baseEnd,
      oldLines: c.oldLines,
      newLines: c.newLines,
      status: 'pending',
    }));
    // Same hunks as an earlier proposal of this run (e.g. the call repeated with other formatting).
    const sameHunks = mine.find(
      (p) => p.path === target.path && p.hunks.length === hunks.length && p.hunks.every((h, k) => h.id === hunks[k]?.id),
    );
    if (sameHunks) return { kind: 'duplicate', proposal: sameHunks };

    const proposal: Proposal = {
      id: `p${this.nextProposal++}`,
      runId: run.id,
      tool,
      path: target.path,
      baseText: target.baseText,
      hunks,
      key,
      state: 'reviewing',
      executed: false,
    };
    this.proposals.push(proposal);
    return { kind: 'staged', proposal };
  }

  private async target(run: Run, tool: string, rawArgs: unknown): Promise<Target> {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    if (tool === 'replace_selection') {
      const sel = run.selection;
      if (!sel) return { ok: false, error: 'replace_selection is only available in an inline edit run. Nothing was staged.' };
      if (typeof args['new_text'] !== 'string') return { ok: false, error: 'replace_selection needs new_text (a string). Nothing was staged.' };
      let baseText: string;
      try {
        baseText = await this.host.readText(sel.path);
      } catch (err) {
        return { ok: false, error: `Cannot read ${sel.path}: ${String(err)}. Nothing was staged.` };
      }
      const lines = splitLines(baseText);
      if (lines.slice(sel.startLine, sel.endLine).join('\n') !== sel.text) {
        return { ok: false, error: `The selected lines of ${sel.path} changed since the request. Nothing was staged.` };
      }
      let replacement = stripLineGutter(stripCodeFence(args['new_text'])).text.replace(/\r\n/g, '\n');
      if (replacement.endsWith('\n') && !sel.text.endsWith('\n')) replacement = replacement.slice(0, -1);
      replacement = stripTrailingWhitespace(replacement, sel.text, true);
      const newLines = [...lines.slice(0, sel.startLine), ...replacement.split('\n'), ...lines.slice(sel.endLine)];
      return { ok: true, path: sel.path, baseText, newText: newLines.join(detectEol(baseText)) };
    }

    if (tool === 'propose_write') {
      const path = args['path'];
      const edits = args['edits'];
      if (typeof path !== 'string' || !Array.isArray(edits) || edits.length === 0) {
        return { ok: false, error: 'propose_write needs path and a non-empty edits list. Nothing was staged.' };
      }
      let baseText: string;
      try {
        baseText = await this.host.readText(path);
      } catch (err) {
        return { ok: false, error: `Cannot read ${path}: ${String(err)}. Nothing was staged.` };
      }
      const result = applyTextEdits(baseText, edits as ProposeWriteArgs['edits']);
      if (!result.ok) return { ok: false, error: `${result.error} Nothing was staged for ${path}.` };
      return { ok: true, path, baseText, newText: result.text };
    }
    return { ok: false, error: `Unknown tool ${tool}.` };
  }
}

/**
 * Applies old_text → new_text replacements to `base`. Each old_text must occur exactly
 * once (after removing a copied read_file gutter); edits must not overlap.
 */
export function applyTextEdits(
  base: string,
  edits: { old_text: unknown; new_text: unknown }[],
): { ok: true; text: string } | { ok: false; error: string } {
  const eol = detectEol(base);
  const found: { start: number; end: number; text: string }[] = [];
  for (const [k, edit] of edits.entries()) {
    const n = k + 1;
    if (typeof edit?.old_text !== 'string' || typeof edit?.new_text !== 'string') {
      return { ok: false, error: `Edit ${n}: old_text and new_text must both be strings.` };
    }
    const toEol = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\n/g, eol);
    let oldText = toEol(edit.old_text);
    let newText = toEol(edit.new_text);
    if (oldText === '') return { ok: false, error: `Edit ${n}: old_text is empty; give the exact existing text to replace.` };

    const count = (needle: string): number => {
      let c = 0;
      for (let i = base.indexOf(needle); i !== -1; i = base.indexOf(needle, i + 1)) c++;
      return c;
    };
    let occurrences = count(oldText);
    if (occurrences === 0) {
      const strippedOld = stripLineGutter(oldText);
      if (strippedOld.stripped && count(strippedOld.text) > 0) {
        oldText = strippedOld.text;
        occurrences = count(oldText);
      }
    }
    const strippedNew = stripLineGutter(newText);
    if (strippedNew.stripped) newText = strippedNew.text;
    newText = stripTrailingWhitespace(newText, oldText, false);

    if (occurrences === 0) {
      return { ok: false, error: `Edit ${n}: old_text was not found in the file. Copy it exactly from read_file, without line numbers.` };
    }
    if (occurrences > 1) {
      return { ok: false, error: `Edit ${n}: old_text occurs ${occurrences} times; include more surrounding lines so it matches exactly once.` };
    }
    const start = base.indexOf(oldText);
    found.push({ start, end: start + oldText.length, text: newText });
  }
  found.sort((a, b) => a.start - b.start);
  for (let k = 1; k < found.length; k++) {
    if ((found[k]?.start ?? 0) < (found[k - 1]?.end ?? 0)) return { ok: false, error: 'Two edits overlap; merge them into one.' };
  }
  let text = base;
  for (const f of [...found].reverse()) text = text.slice(0, f.start) + f.text + text.slice(f.end);
  return { ok: true, text };
}
