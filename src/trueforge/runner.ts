// One Ripple run = one TrueForge session + turn, bound to one TransactionManager run.
// No `vscode` imports: the extension supplies the UI callbacks.
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { SelectionTarget, TransactionManager } from '../core/transactions';
import { isRetryableModelError, unwrapToolCall, type ApprovalDecision, type PendingToolCall, type ToolCallUpdate, type TrueForgeClient } from './client';

const WRITE_TOOLS = ['propose_write', 'replace_selection'] as const;

export interface RunRequest {
  spec: TrueForgeApi.AgentSpec;
  message: string;
  selection?: SelectionTarget;
  /** When true, accepted hunks are held in memory across files until command or finish. */
  deferred?: boolean;
  /** Approval for tools that are not write tools (none in Task A). */
  decideOther(call: PendingToolCall): Promise<ApprovalDecision>;
  onDelta?(text: string, kind: 'content' | 'tool'): void;
  onToolCall?(call: ToolCallUpdate): void;
  /** Called once per attempt with the run and its TrueForge session. */
  onSession?(runId: string, sessionId: string): void;
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
    const runIds: string[] = [];
    for (let attempt = 1; ; attempt++) {
      const run = tx.beginRun(req.selection, { deferred: req.deferred });
      runIds.push(run.id);
      const current: { runId: string; sessionId?: string; cancelled: boolean } = { runId: run.id, cancelled: false };
      this.current = current;
      log(`[run] ${run.id} started (attempt ${attempt}/${maxAttempts}, model ${req.spec.model.name})`);
      let failure: string | undefined;
      try {
        // The MCP URL carries this run's token, so every tool call is bound to this run.
        await tf.registerMcpServer(this.deps.mcpUrlForRun(run.token), this.deps.mcpBearer);
        const sessionId = await tf.createSession(req.spec);
        current.sessionId = sessionId;
        log(`[trueforge] session ${sessionId}`);
        req.onSession?.(run.id, sessionId);
        if (current.cancelled) {
          await tf.cancel(sessionId).catch(() => undefined);
          return await this.end(run.id, 'cancelled', { status: 'cancelled', runIds, attempts: attempt });
        }
        let writeCalls = 0;
        const turn = (text: string) => tf.runTurn(sessionId, text, {
          log,
          ...(req.onDelta ? { onDelta: req.onDelta } : {}),
          ...(req.onToolCall ? { onToolCall: req.onToolCall } : {}),
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
        let outcome = await turn(req.message);
        if (outcome.status === 'done' && writeCalls === 0 && req.nudge && !current.cancelled) {
          log(`[run] ${run.id} turn ended without a write tool call; sending one follow-up turn`);
          outcome = await turn(req.nudge);
        }
        log(`[run] ${run.id} turn finished: ${outcome.status}${outcome.message ? ` (${outcome.message})` : ''}`);
        if (current.cancelled || outcome.status === 'cancelled') {
          return await this.end(run.id, 'cancelled', { status: 'cancelled', runIds, attempts: attempt });
        }
        if (outcome.status === 'done') {
          if (run.deferred) {
            const committed = await tx.commit(run.id);
            if (!committed.ok) {
              return await this.end(run.id, 'failed', { status: 'error', message: committed.error, runIds, attempts: attempt });
            }
            log(`[run] ${run.id} committed ${committed.hunks} hunks across ${committed.files.length} files`);
          }
          return await this.end(run.id, 'finished', { status: 'done', runIds, attempts: attempt });
        }
        failure = outcome.message ?? outcome.status;
      } catch (err) {
        if (current.cancelled) return await this.end(run.id, 'cancelled', { status: 'cancelled', runIds, attempts: attempt });
        failure = err instanceof Error ? err.message : String(err);
        log(`[run] ${run.id} failed: ${failure}`);
      }
      const applied = tx.proposalsFor(run.id).some((p) => p.state === 'applied');
      await this.end(run.id, 'failed', undefined);
      if (isRetryableModelError(failure) && attempt < maxAttempts && !applied) {
        log(`[run] retryable model error; retrying with a fresh run and session`);
        continue;
      }
      return { status: 'error', message: failure, runIds, attempts: attempt };
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
