// One Ripple run = one TrueForge session + turn, bound to one TransactionManager run.
// No `vscode` imports: the extension supplies the UI callbacks.
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { SelectionTarget, TransactionManager } from '../core/transactions';
import { isQuotaExhausted, isRetryableModelError, unwrapToolCall, type ApprovalDecision, type CompactionInfo, type PendingToolCall, type ToolCallUpdate, type TrueForgeClient } from './client';

const WRITE_TOOLS = ['propose_write', 'replace_selection'] as const;

export interface RunRequest {
  spec: TrueForgeApi.AgentSpec;
  /** Configured fallback model specification if primary model fails. */
  fallbackSpec?: TrueForgeApi.AgentSpec;
  message: string;
  selection?: SelectionTarget;
  /** When true, accepted hunks are held in memory across files until command or finish. */
  deferred?: boolean;
  /** Approval for tools that are not write tools (none in Task A). */
  decideOther(call: PendingToolCall): Promise<ApprovalDecision>;
  onDelta?(text: string, kind: 'content' | 'tool'): void;
  onToolCall?(call: ToolCallUpdate): void;
  /** TrueForge compacted the conversation (context-engineering feature, shown to the user). */
  onCompaction?(info: CompactionInfo): void;
  /** Called once per attempt with the run and its TrueForge session. */
  onSession?(runId: string, sessionId: string): void;
  /** Notified when primary model fails and runner falls back to secondary model. */
  onFallback?(fromModel: string, toModel: string, reason: string): void;
  /**
   * Sent once as a follow-up turn on the same session when a turn ends without any write
   * tool call (small local models sometimes write the call as text).
   */
  nudge?: string;
  /** Total attempts for retryable model errors (cold model, timeout). Default 2. */
  attempts?: number;
}

export interface RunResult {
  status: 'done' | 'cancelled' | 'error';
  message?: string;
  runIds: string[];
  attempts: number;
  /** Model that ran the last attempt. */
  model?: string;
  /** Set when the primary model failed and the fallback model took over. */
  fallback?: { from: string; to: string; reason: string };
  /** Hunks written to the workspace by this run. Set when status is `done`. */
  hunksWritten?: number;
}

/**
 * A `done` run that wrote nothing is not a success the user should take on trust, least of
 * all after a silent switch to the fallback model. Returns the warning to show, if any.
 */
export function describeOutcome(result: RunResult): string | undefined {
  if (result.status !== 'done') return undefined;
  const wroteNothing = result.hunksWritten === 0;
  if (result.fallback) {
    const switched = `${result.fallback.from} failed (${result.fallback.reason}); ${result.fallback.to} took over`;
    return wroteNothing
      ? `${switched} and finished without changing any file. The task was not carried out.`
      : `${switched} and wrote ${result.hunksWritten ?? 'the'} change(s). Review them: they come from the fallback model.`;
  }
  return wroteNothing ? 'The run finished without changing any file.' : undefined;
}

export interface RunnerDeps {
  tx: TransactionManager;
  tf: TrueForgeClient;
  /** URL to register for a run's token, plus the server's bearer token. */
  mcpUrlForRun(runToken: string): string;
  mcpBearer: string;
  log(line: string): void;
  /** Called when a run is cancelled, so the UI can close its reviews. */
  onRunEnded?(runId: string, state: 'finished' | 'cancelled' | 'failed'): void;
}

/** Canonical write-tool name, whatever prefix TrueForge put on it. */
export function writeToolName(name: string): (typeof WRITE_TOOLS)[number] | undefined {
  return WRITE_TOOLS.find((t) => name === t || name.endsWith(`__${t}`) || name.endsWith(`.${t}`) || name.endsWith(`_${t}`));
}

export class Runner {
  private current: { runId: string; sessionId?: string; cancelled: boolean } | undefined;

  constructor(private readonly deps: RunnerDeps) {}

  get busy(): boolean {
    return this.current !== undefined;
  }

  async run(req: RunRequest): Promise<RunResult> {
    if (this.current) throw new Error('A Ripple run is already in progress; cancel it first.');
    const { tx, tf, log } = this.deps;
    const maxAttempts = req.attempts ?? 2;

    // Preserve the same run and transaction identity across recovery and fallback
    const run = tx.beginRun(req.selection, { deferred: req.deferred });
    const runIds: string[] = [run.id];
    const current: { runId: string; sessionId?: string; cancelled: boolean } = { runId: run.id, cancelled: false };
    this.current = current;

    // The MCP URL carries this run's token, so every tool call is bound to this run
    await tf.registerMcpServer(this.deps.mcpUrlForRun(run.token), this.deps.mcpBearer);

    let activeSpec = req.spec;
    let switchedToFallback = false;
    let fallback: RunResult['fallback'];
    let totalAttempts = 0;
    /** Set after an interrupted attempt: what the next attempt is told about the kept changes. */
    let continuation: string | undefined;

    for (let attempt = 1; ; attempt++) {
      totalAttempts = attempt;
      log(`[run] ${run.id} started (attempt ${attempt}, model ${activeSpec.model.name})`);

      if (current.cancelled) {
        return await this.end(run.id, 'cancelled', { status: 'cancelled', runIds, attempts: totalAttempts });
      }

      let failure: string | undefined;
      try {
        const sessionId = await tf.createSession(activeSpec);
        current.sessionId = sessionId;
        log(`[trueforge] session ${sessionId}`);
        req.onSession?.(run.id, sessionId);

        if (current.cancelled) {
          await tf.cancel(sessionId).catch(() => undefined);
          return await this.end(run.id, 'cancelled', { status: 'cancelled', runIds, attempts: totalAttempts });
        }

        let writeCalls = 0;
        const turn = (text: string) => tf.runTurn(sessionId, text, {
          log,
          ...(req.onDelta ? { onDelta: req.onDelta } : {}),
          ...(req.onToolCall ? { onToolCall: req.onToolCall } : {}),
          ...(req.onCompaction ? { onCompaction: req.onCompaction } : {}),
          isCancelled: () => current.cancelled,
          decide: async (raw) => {
            // A deferred tool arrives wrapped in call_tool; approve the tool actually meant.
            const real = unwrapToolCall(raw.toolName, raw.arguments);
            const call: PendingToolCall = { ...raw, toolName: real.name, arguments: real.args };
            const tool = writeToolName(call.toolName);
            if (!tool) return req.decideOther(call);
            writeCalls++;
            let args: unknown;
            try {
              args = JSON.parse(call.arguments || '{}');
            } catch {
              // Let the tool report the malformed arguments; nothing can be written.
              return { allow: true };
            }
            const answer = await tx.reviewForApproval(run.id, tool, args);
            return answer.allow ? { allow: true } : { allow: false, reason: answer.reason };
          },
        });

        let outcome = await turn(continuation ? `${req.message}\n\n${continuation}` : req.message);
        if (outcome.status === 'done' && writeCalls === 0 && req.nudge && !current.cancelled) {
          log(`[run] ${run.id} turn ended without a write tool call; sending one follow-up turn`);
          outcome = await turn(req.nudge);
        }

        log(`[run] ${run.id} turn finished: ${outcome.status}${outcome.message ? ` (${outcome.message})` : ''}`);

        if (current.cancelled || outcome.status === 'cancelled') {
          return await this.end(run.id, 'cancelled', { status: 'cancelled', runIds, attempts: totalAttempts });
        }

        if (outcome.status === 'done') {
          if (run.deferred) {
            const committed = await tx.commit(run.id);
            if (!committed.ok) {
              return await this.end(run.id, 'failed', { status: 'error', message: committed.error, runIds, attempts: totalAttempts });
            }
            log(`[run] ${run.id} committed ${committed.hunks} hunks across ${committed.files.length} files`);
          }
          const hunksWritten = tx
            .proposalsFor(run.id)
            .reduce((sum, p) => sum + p.hunks.filter((h) => h.status === 'applied').length, 0);
          const result: RunResult = {
            status: 'done',
            runIds,
            attempts: totalAttempts,
            model: activeSpec.model.name,
            hunksWritten,
            ...(fallback ? { fallback } : {}),
          };
          const warning = describeOutcome(result);
          if (warning) {
            result.message = warning;
            log(`[run] ${run.id} done with a warning: ${warning}`);
          }
          return await this.end(run.id, 'finished', result);
        }

        failure = outcome.message ?? outcome.status;
      } catch (err) {
        if (current.cancelled) return await this.end(run.id, 'cancelled', { status: 'cancelled', runIds, attempts: totalAttempts });
        failure = err instanceof Error ? err.message : String(err);
        log(`[run] ${run.id} failed: ${failure}`);
      }

      // An agent run interrupted by the model (timeout, overload, connection) keeps the edits the
      // user already accepted, and the next attempt continues from them. A model that misbehaved
      // (invalid output) starts again clean. Either way, if every attempt fails the whole run is
      // rolled back, so the workspace ends unchanged.
      const proposals = tx.proposalsFor(run.id);
      const accepted = proposals.some((p) => p.state === 'held' || p.state === 'applied');
      // A used-up quota is an interruption too: the fallback model can carry on from the kept edits.
      const canContinue = run.deferred && accepted && (isRetryableModelError(failure) || isQuotaExhausted(failure));
      if (!canContinue && proposals.some((p) => p.state === 'applied')) {
        await this.end(run.id, 'failed', undefined);
        return { status: 'error', message: failure, runIds, attempts: totalAttempts, model: activeSpec.model.name, ...(fallback ? { fallback } : {}) };
      }

      if (current.cancelled) {
        return await this.end(run.id, 'cancelled', { status: 'cancelled', runIds, attempts: totalAttempts });
      }

      if (canContinue) {
        tx.discardUncommitted(run.id, `interrupted on ${activeSpec.model.name}: ${failure}`, { keepAccepted: true });
        const done = tx.progressSummary(run.id) ?? '';
        continuation =
          `Note from Ripple: a previous attempt on ${activeSpec.model.name} was interrupted by a model error (${failure}). ` +
          `The changes the user accepted are kept.\n${done}\n` +
          'Continue the task from there: read the current lines where needed, make only the remaining changes, then run the tests.';
        log(`[run] ${run.id} keeps its accepted changes; the next attempt continues from them`);
      } else {
        // Clean uncommitted or stale proposals from the failed attempt, keeping transaction run intact
        tx.discardUncommitted(run.id, `failure on ${activeSpec.model.name}: ${failure}`);
        continuation = undefined;
      }

      // Bounded retries for transient/retryable errors on primary model
      if (!switchedToFallback && isRetryableModelError(failure) && attempt < maxAttempts) {
        log(`[run] retryable model error on ${activeSpec.model.name}; retrying on same transaction`);
        continue;
      }

      // Automatic fallback to configured secondary model
      if (!switchedToFallback && req.fallbackSpec && req.fallbackSpec.model.name !== activeSpec.model.name) {
        const fromModel = activeSpec.model.name;
        activeSpec = req.fallbackSpec;
        switchedToFallback = true;
        fallback = { from: fromModel, to: activeSpec.model.name, reason: failure ?? 'primary model failure' };
        log(`[fallback] primary model ${fromModel} failed (${failure}); switching to fallback model ${activeSpec.model.name}`);
        req.onFallback?.(fromModel, activeSpec.model.name, failure ?? 'primary model failure');
        continue;
      }

      await this.end(run.id, 'failed', undefined);
      return {
        status: 'error',
        message: fallback ? `${failure} (fallback model ${fallback.to}, after ${fallback.from} failed: ${fallback.reason})` : failure,
        runIds,
        attempts: totalAttempts,
        model: activeSpec.model.name,
        ...(fallback ? { fallback } : {}),
      };
    }
  }

  /** Cancels the current run: staged hunks are discarded at once, then TrueForge is told. */
  async cancel(): Promise<boolean> {
    const current = this.current;
    if (!current || current.cancelled) return false;
    current.cancelled = true;
    this.deps.log(`[run] ${current.runId} cancel requested`);
    this.deps.tx.endRun(current.runId, 'cancelled');
    await this.deps.tx.rollback(current.runId);
    this.deps.onRunEnded?.(current.runId, 'cancelled');
    if (current.sessionId) {
      try {
        await this.deps.tf.cancel(current.sessionId);
        this.deps.log(`[trueforge] sessions.cancel(${current.sessionId}) sent`);
      } catch (err) {
        this.deps.log(`[trueforge] sessions.cancel failed: ${String(err)}`);
      }
    }
    return true;
  }

  private async end<T>(runId: string, state: 'finished' | 'cancelled' | 'failed', result: T): Promise<T> {
    this.deps.tx.endRun(runId, state);
    if (state !== 'finished') {
      await this.deps.tx.rollback(runId);
    }
    this.deps.onRunEnded?.(runId, state);
    if (this.current?.runId === runId) this.current = undefined;
    return result;
  }
}
