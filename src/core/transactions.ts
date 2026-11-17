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
  /**
   * Agent runs. Accepted hunks are held in memory, across files, and written together as one
   * edit when the run commits (before an approved command runs, and when the run finishes).
   * A cancelled or failed run writes nothing and takes back anything it had committed.
   */
  readonly deferred: boolean;
}

/** A file as one run sees it: before the run, on disk now, and with its accepted hunks. */
interface StagedFile {
  original: string;
  disk: string;
  current: string;
  /** The run creates this file: it did not exist before the run. */
  created: boolean;
  /** For a created file: whether a commit has put it on disk yet. */
  onDisk: boolean;
}

export type HunkStatus = 'pending' | 'accepted' | 'held' | 'rejected' | 'applied' | 'failed';

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

export type ProposalState = 'reviewing' | 'decided' | 'held' | 'applied' | 'rejected' | 'failed' | 'discarded';

export interface Proposal {
  /** How many times the identical edit was proposed again after this one. */
  repeats?: number;
  readonly id: string;
  readonly runId: string;
  readonly tool: string;
  readonly path: string;
  readonly baseText: string;
  /** True when the file does not exist yet: accepting the proposal creates it. */
  readonly creates: boolean;
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
  /**
   * Applies edits to several files as ONE edit (one undo step across files) and saves them,
   * but only if every file still equals its `baseText`. Otherwise writes nothing and returns
   * the path that changed. Without it, files are applied one after another.
   */
  applyAll?(changes: FileChange[]): Promise<'ok' | { changed: string }>;
  /** Shows the review. Resolves when every hunk is decided or the review is closed. */
  review(proposal: Proposal): Promise<void>;
}

export interface FileChange {
  path: string;
  baseText: string;
  edits: TextReplacement[];
  /** The file must not exist; it is created (baseText is '') as part of the same edit. */
  create?: boolean;
  /** The file is deleted (taking back a creation), if it still equals baseText. */
  remove?: boolean;
}

export interface CommitResult {
  ok: boolean;
  /** Files written by this commit. */
  files: string[];
  hunks: number;
  error?: string;
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

export type ApprovalAnswer = { allow: true } | { allow: false; reason: string };

/** Everything one run wrote, so it can be undone as one step. */
export interface AppliedChange {
  runId: string;
  /** `created`: the run created the file, so undoing the run deletes it. */
  files: { path: string; before: string; after: string; created?: boolean }[];
}

export class StaleRunError extends Error {}

export interface ProposeWriteArgs {
  path: string;
  edits: { old_text: string; new_text: string }[];
}

export interface ReplaceSelectionArgs {
  new_text: string;
}

const CRLF = String.fromCharCode(13, 10);
const STATUS_STAGED = 'staged, awaiting review';
const STATUS_APPLIED = 'applied';
const STATUS_HELD = 'accepted by the user and staged; not on disk yet (written when run_command runs or when the run ends)';
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
    case 'held':
      return STATUS_HELD;
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
type Target = { ok: true; path: string; baseText: string; newText: string; creates?: boolean } | { ok: false; error: string };

export class TransactionManager {
  private readonly runs = new Map<string, Run>();
  private readonly byToken = new Map<string, Run>();
  private readonly proposals: Proposal[] = [];
  private readonly reviews = new Map<string, () => void>();
  private readonly staging = new Map<string, Promise<void>>();
  private nextRun = 1;
  private nextProposal = 1;
  private readonly stagedFiles = new Map<string, Map<string, StagedFile>>();
  lastApplied: AppliedChange | undefined;
  /** Called after any change to runs, proposals or hunks (the panel redraws from it). */
  onDidChange: (() => void) | undefined;

  constructor(private readonly host: EditorHost) {}

  beginRun(selection?: SelectionTarget, options: { deferred?: boolean } = {}): Run {
    const run: Run = {
      id: `run-${this.nextRun++}`,
      token: randomBytes(16).toString('base64url'),
      state: 'active',
      deferred: options.deferred ?? false,
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
      if (p.state === 'reviewing' || p.state === 'decided' || p.state === 'held') {
        p.state = 'discarded';
        for (const h of p.hunks) {
          if (h.status === 'pending' || h.status === 'accepted' || h.status === 'held') {
            h.status = 'failed';
            h.reason = `run ${state}, nothing written`;
          }
        }
      }
      this.reviews.get(p.id)?.();
      this.reviews.delete(p.id);
    }
    this.onDidChange?.();
  }

  /** The text of a file as this run sees it: with the hunks accepted so far, else the editor's text. */
  async readForRun(token: string, path: string): Promise<string> {
    const run = this.requireActive(token);
    return this.stagedFiles.get(run.id)?.get(path)?.current ?? this.host.readText(path);
  }

  /** Text a run holds for `path` (with its accepted hunks), if any. */
  stagedText(runId: string, path: string): string | undefined {
    return this.stagedFiles.get(runId)?.get(path)?.current;
  }

  /**
   * Discards held/uncommitted proposals and resets staged text to disk for a run,
   * keeping the run active (used during model fallback / retry to clear stale proposals).
   */
  discardUncommitted(runId: string, reason = 'retry with fresh model'): void {
    const staged = this.stagedFiles.get(runId);
    if (staged) {
      for (const [, f] of staged) {
        f.current = f.disk;
      }
    }
    for (const p of this.proposals) {
      if (p.runId !== runId) continue;
      if (p.state === 'held' || p.state === 'reviewing' || p.state === 'decided') {
        p.state = 'discarded';
        for (const h of p.hunks) {
          if (h.status === 'pending' || h.status === 'held' || h.status === 'accepted') {
            h.status = 'failed';
            h.reason = reason;
          }
        }
        this.reviews.get(p.id)?.();
        this.reviews.delete(p.id);
      }
    }
    this.onDidChange?.();
  }

  /**
   * Writes everything the run holds as ONE edit across files. Called before an approved
   * command runs (so it tests the accepted edits) and when the run finishes. All or nothing:
   * if a file changed outside Ripple, nothing is written and the held hunks fail.
   */
  async commit(runId: string): Promise<CommitResult> {
    const run = this.runs.get(runId);
    const staged = this.stagedFiles.get(runId);
    if (!run || run.state !== 'active') return { ok: false, files: [], hunks: 0, error: `${runId} is not active; nothing was written` };
    const held = this.proposals.filter((p) => p.runId === runId && p.state === 'held');
    const pending = [...(staged ?? new Map<string, StagedFile>())].filter(([, f]) => f.current !== f.disk);
    if (pending.length === 0) return { ok: true, files: [], hunks: 0 };
    const changes: FileChange[] = pending.map(([path, f]) =>
      f.created && !f.onDisk
        ? { path, baseText: '', edits: [{ start: 0, end: 0, text: f.current }], create: true }
        : { path, baseText: f.disk, edits: replacementsBetween(f.disk, f.current) },
    );
    let failed: string | undefined;
    if (this.host.applyAll) {
      const result = await this.host.applyAll(changes);
      if (result !== 'ok') failed = result.changed;
    } else if (changes.some((c) => c.create)) {
      failed = changes.find((c) => c.create)?.path;
    } else {
      for (const c of changes) {
        if ((await this.host.applyEdits(c.path, c.baseText, c.edits)) === 'changed') {
          failed = c.path;
          break;
        }
        const f = staged?.get(c.path);
        if (f) f.disk = f.current;
      }
    }
    if (failed !== undefined) {
      const reason = `${failed} changed outside Ripple after the edit was staged; read it again and re-propose`;
      for (const p of held) {
        p.state = 'failed';
        for (const h of p.hunks) {
          if (h.status === 'held') {
            h.status = 'failed';
            h.reason = reason;
          }
        }
      }
      // Forget the staged text that could not be written; what is on disk stays as it is.
      for (const [, f] of pending) f.current = f.disk;
      this.onDidChange?.();
      return { ok: false, files: [], hunks: 0, error: `Nothing was written: ${reason}.` };
    }
    let hunks = 0;
    for (const p of held) {
      p.state = 'applied';
      for (const h of p.hunks) {
        if (h.status === 'held') {
          h.status = 'applied';
          hunks++;
        }
      }
    }
    for (const [, f] of pending) {
      f.disk = f.current;
      if (f.created) f.onDisk = true;
    }
    this.lastApplied = {
      runId,
      files: [...(staged ?? [])]
        .filter(([, f]) => (f.created ? f.onDisk : f.disk !== f.original))
        .map(([path, f]) => ({ path, before: f.original, after: f.disk, ...(f.created ? { created: true } : {}) })),
    };
    this.onDidChange?.();
    return { ok: true, files: pending.map(([path]) => path), hunks };
  }

  /**
   * After a cancelled or failed run: takes back, as one edit, what the run had already
   * committed, so the workspace is as it was before the run. Returns the files restored.
   */
  async rollback(runId: string): Promise<string[]> {
    const staged = this.stagedFiles.get(runId);
    this.stagedFiles.delete(runId);
    const written = [...(staged ?? [])].filter(([, f]) => (f.created ? f.onDisk : f.disk !== f.original));
    if (written.length === 0) return [];
    // A file the run created is deleted again; any other file gets its old text back.
    const changes: FileChange[] = written.map(([path, f]) =>
      f.created ? { path, baseText: f.disk, edits: [], remove: true } : { path, baseText: f.disk, edits: [{ start: 0, end: f.disk.length, text: f.original }] },
    );
    const restored: string[] = [];
    if (this.host.applyAll) {
      if ((await this.host.applyAll(changes)) === 'ok') restored.push(...changes.map((c) => c.path));
    } else {
      for (const c of changes) if ((await this.host.applyEdits(c.path, c.baseText, c.edits)) === 'ok') restored.push(c.path);
    }
    for (const p of this.proposals) {
      if (p.runId !== runId || p.state !== 'applied') continue;
      p.state = 'discarded';
      for (const h of p.hunks) {
        if (h.status === 'applied') {
          h.status = 'failed';
          h.reason = restored.includes(p.path) ? 'the run did not finish; the change was taken back' : 'the run did not finish';
        }
      }
    }
    if (this.lastApplied?.runId === runId) this.lastApplied = undefined;
    this.onDidChange?.();
    return restored;
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
    this.onDidChange?.();
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
      p.repeats = (p.repeats ?? 0) + 1;
      // Seen: a model resending the same edit dozens of times. Say plainly that it is done.
      const stop =
        p.repeats >= 2
          ? `\nThis is repeat ${p.repeats} of the same edit. It is done; do not propose it again. Move on to the next file, or finish and summarise.`
          : '';
      return { isError: false, text: `${what}: this exact edit to ${p.path} was proposed before in this run (proposal ${p.id}). Nothing new was staged.${stop}\n${this.report(p)}` };
    }
    if (p.state === 'reviewing') await this.awaitReview(p);
    this.closeUndecided(p);
    if (run.state !== 'active' || p.state === 'discarded') {
      return { isError: true, text: `Rejected: ${run.id} is ${run.state}. Nothing was written.` };
    }
    const outcome = run.deferred ? await this.holdDecided(run, p) : await this.applyDecided(p);
    this.onDidChange?.();
    return outcome;
  }

  /** Agent runs: keeps the accepted hunks in the run's staged copy of the file. Writes nothing. */
  private async holdDecided(run: Run, p: Proposal): Promise<ToolOutcome> {
    p.executed = true;
    const accepted = p.hunks.filter((h) => h.status === 'accepted');
    if (accepted.length === 0) {
      p.state = 'rejected';
      return { isError: false, text: this.report(p) };
    }
    let files = this.stagedFiles.get(run.id);
    if (!files) this.stagedFiles.set(run.id, (files = new Map()));
    const entry = files.get(p.path);
    const now = entry?.current ?? (await this.host.readText(p.path).catch(() => undefined));
    // A new file must still not exist; an existing one must still have the text the hunks were made from.
    if (p.creates && !entry ? now !== undefined : now !== p.baseText) {
      p.state = 'failed';
      for (const h of accepted) {
        h.status = 'failed';
        h.reason = 'the file changed after the edit was staged; read it again and re-propose';
      }
      return { isError: true, text: this.report(p) };
    }
    const next = applyReplacements(p.baseText, this.replacements(p, accepted));
    if (entry) entry.current = next;
    else files.set(p.path, { original: p.baseText, disk: p.baseText, current: next, created: p.creates, onDisk: !p.creates });
    p.state = 'held';
    for (const h of accepted) h.status = 'held';
    return { isError: false, text: this.report(p) };
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
    const edits = this.replacements(p, accepted);
    let result: 'ok' | 'changed';
    if (!p.creates) result = await this.host.applyEdits(p.path, p.baseText, edits);
    else if (!this.host.applyAll) result = 'changed';
    else result = (await this.host.applyAll([{ path: p.path, baseText: '', edits: [{ start: 0, end: 0, text: applyReplacements('', edits) }], create: true }])) === 'ok' ? 'ok' : 'changed';
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
    this.lastApplied = {
      runId: p.runId,
      files: [{ path: p.path, before: p.baseText, after: applyReplacements(p.baseText, edits), ...(p.creates ? { created: true } : {}) }],
    };
    return { isError: false, text: this.report(p) };
  }

  /** The accepted hunks of a proposal as character replacements in its base text. */
  private replacements(p: Proposal, accepted: Hunk[]): TextReplacement[] {
    const offsets = lineOffsets(p.baseText);
    const eol = detectEol(p.baseText);
    const lineCount = splitLines(p.baseText).length;
    return accepted.map((h) => {
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
  }

  /** Precise per-hunk status text for the model. Never implies a write that did not happen. */
  report(p: Proposal): string {
    const lines = p.hunks.map((h) => `- hunk ${h.id} (${describeLines(h)}): ${hunkStatusText(h)}`);
    const applied = p.hunks.filter((h) => h.status === 'applied').length;
    const held = p.hunks.filter((h) => h.status === 'held').length;
    const tail = held
      ? p.creates
        ? `New file ${p.path} is staged (read_file shows it); it does not exist on disk yet.`
        : `${held} of ${p.hunks.length} hunk(s) are staged for ${p.path} (read_file shows them); nothing is on disk yet.`
      : applied === 0
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
      creates: target.creates ?? false,
      hunks,
      key,
      state: 'reviewing',
      executed: false,
    };
    this.proposals.push(proposal);
    this.onDidChange?.();
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
        baseText = this.stagedFiles.get(run.id)?.get(path)?.current ?? (await this.host.readText(path));
      } catch (err) {
        // The file does not exist: one edit with an empty old_text creates it, reviewed like any edit.
        const only = edits.length === 1 ? (edits[0] as { old_text?: unknown; new_text?: unknown }) : undefined;
        const outside = /outside the workspace|path is empty/.test(String(err));
        if (!outside && only && only.old_text === '' && typeof only.new_text === 'string' && only.new_text.trim() !== '') {
          const text = stripLineGutter(stripCodeFence(only.new_text)).text.replace(/\r\n/g, '\n');
          return { ok: true, path, baseText: '', newText: text.endsWith('\n') ? text : `${text}\n`, creates: true };
        }
        return {
          ok: false,
          error: outside
            ? `Cannot use ${path}: ${String(err)}. Nothing was staged.`
            : `${path} does not exist. To create it, call propose_write with exactly one edit whose old_text is "" and whose new_text is the whole file. Nothing was staged.`,
        };
      }
      const result = applyTextEdits(baseText, edits as ProposeWriteArgs['edits']);
      if (!result.ok) return { ok: false, error: `${result.error} Nothing was staged for ${path}.` };
      return { ok: true, path, baseText, newText: result.text };
    }
    return { ok: false, error: `Unknown tool ${tool}.` };
  }
}

export function applyReplacements(text: string, edits: TextReplacement[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Minimal line-level replacements that turn `from` into `to`. */
export function replacementsBetween(from: string, to: string): TextReplacement[] {
  const a = splitLines(from);
  const offsets = lineOffsets(from);
  const eol = detectEol(from);
  const out: TextReplacement[] = [];
  for (const c of diffLines(a, splitLines(to))) {
    const toEnd = c.baseEnd >= a.length;
    let start = offsets[c.baseStart] ?? from.length;
    const end = toEnd ? from.length : (offsets[c.baseEnd] ?? from.length);
    let text = c.newLines.join(eol);
    if (c.newLines.length > 0 && !toEnd) text += eol;
    if (toEnd && c.baseStart >= a.length && c.newLines.length > 0) text = eol + text;
    if (c.newLines.length === 0 && toEnd && start > 0) start -= from.slice(0, start).endsWith(CRLF) ? 2 : 1;
    out.push({ start, end, text });
  }
  // Anything unusual (mixed line endings): replace the whole text instead.
  return applyReplacements(from, out) === to ? out : [{ start: 0, end: from.length, text: to }];
}

const leading = (line: string): number => (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;

/**
 * Finds old_text in `base` ignoring indentation and trailing spaces. When it matches exactly once
 * and every non-blank line is off by the same indentation, returns the file's real text and
 * new_text shifted by that amount.
 */
function looseMatch(
  base: string,
  eol: string,
  oldText: string,
  newText: string,
): { kind: 'unique'; oldText: string; newText: string } | { kind: 'none' | 'ambiguous' } {
  const baseLines = base.split(eol);
  const oldLines = oldText.split(eol);
  while (oldLines.length > 1 && oldLines.at(-1)?.trim() === '') oldLines.pop();
  while (oldLines.length > 1 && oldLines[0]?.trim() === '') oldLines.shift();
  if (oldLines.every((l) => l.trim() === '')) return { kind: 'none' };
  const starts: number[] = [];
  for (let i = 0; i + oldLines.length <= baseLines.length; i++) {
    if (oldLines.every((l, k) => l.trim() === (baseLines[i + k] ?? '').trim())) starts.push(i);
  }
  if (starts.length === 0) return { kind: 'none' };
  if (starts.length > 1) return { kind: 'ambiguous' };
  const at = starts[0]!;
  const deltas = new Set<number>();
  oldLines.forEach((l, k) => {
    if (l.trim()) deltas.add(leading(baseLines[at + k] ?? '') - leading(l));
  });
  if (deltas.size !== 1) return { kind: 'none' };
  const delta = [...deltas][0]!;
  const shifted = newText
    .split(eol)
    .map((l) => {
      if (!l.trim() || delta === 0) return l;
      if (delta > 0) return ' '.repeat(delta) + l;
      return leading(l) >= -delta ? l.replace(/^[ \t]*/, (ws) => ' '.repeat(ws.replace(/\t/g, '    ').length + delta)) : l;
    })
    .join(eol);
  // Keep the span to whole lines of the file, ending where old_text ended.
  const realOld = baseLines.slice(at, at + oldLines.length).join(eol);
  return { kind: 'unique', oldText: realOld, newText: oldText.endsWith(eol) && !shifted.endsWith(eol) ? shifted + eol : shifted };
}

/** The file's own lines closest to old_text's first line, so the agent can copy them. */
function nearestHint(base: string, oldText: string): string {
  const first = oldText.split(/\r?\n/).find((l) => l.trim())?.trim();
  if (!first || first.length < 8) return '';
  const lines = base.split(/\r?\n/);
  const k = lines.findIndex((l) => l.trim() === first);
  if (k < 0) return '';
  return ` Its first line occurs at line ${k + 1}; read_file lines ${k + 1}-${Math.min(lines.length, k + oldText.split(/\r?\n/).length + 2)} and copy them exactly.`;
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

    if (occurrences === 0) {
      // Same lines with different indentation or trailing spaces: take the file's own text,
      // and shift new_text by the same indentation, but only when that shift is unambiguous.
      const loose = looseMatch(base, eol, oldText, newText);
      if (loose.kind === 'unique') {
        oldText = loose.oldText;
        newText = loose.newText;
        occurrences = 1;
      } else {
        const hint = loose.kind === 'ambiguous' ? ' Lines like these occur more than once; include more surrounding lines.' : nearestHint(base, oldText);
        return { ok: false, error: `Edit ${n}: old_text was not found in the file. Copy it exactly from read_file, without line numbers.${hint}` };
      }
    }
    newText = stripTrailingWhitespace(newText, oldText, false);

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
