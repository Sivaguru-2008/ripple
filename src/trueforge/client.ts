// TrueForge client: the only path from Ripple to a model. Ripple never calls a model
// provider; it creates TrueForge sessions, streams turns and answers approval pauses.
// API names below are from @truefoundry/trueforge-sdk 0.185.0 (see AGENTS.md section 9).
import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta, serialization } from '@truefoundry/trueforge-sdk';

export const MCP_SERVER_NAME = 'ripple';

type StreamEvent = TrueForgeApi.TurnStreamingEvent;

export interface PendingToolCall {
  toolCallId: string;
  threadId: string;
  /** Tool name as the model called it (for deferred tools this is `call_tool`). */
  toolName: string;
  /** Raw JSON argument string from the model. */
  arguments: string;
}

/** A tool call as the panel shows it: announced when the model makes it, updated when it is answered. */
export interface ToolCallUpdate {
  id: string;
  /** The real tool, also when it was reached through the deferred-tool `call_tool`. */
  name: string;
  args: string;
  status: 'running' | 'done' | 'denied' | 'error';
  result?: string;
}

/**
 * A deferred tool is called as `call_tool({ mcp_server, tool_name, input })`. Returns the
 * tool actually meant and its arguments; other calls are returned unchanged.
 */
export function unwrapToolCall(name: string, args: string): { name: string; args: string; deferred: boolean } {
  if (name === 'call_tool' || name.endsWith('__call_tool')) {
    try {
      const parsed = JSON.parse(args || '{}') as { tool_name?: unknown; input?: unknown };
      if (typeof parsed.tool_name === 'string') return { name: parsed.tool_name, args: JSON.stringify(parsed.input ?? {}), deferred: true };
    } catch {
      // arguments still streaming or malformed: show the call as it is
    }
  }
  return { name, args, deferred: false };
}

export type ApprovalDecision = { allow: true } | { allow: false; reason?: string };

export interface TurnHandlers {
  log(line: string): void;
  decide(call: PendingToolCall): Promise<ApprovalDecision>;
  /** Streamed text as it arrives: assistant content, or tool-call argument fragments. */
  onDelta?(text: string, kind: 'content' | 'tool'): void;
  /** Notified when a tool call is seen or answered. */
  onToolCall?(call: ToolCallUpdate): void;
  /** True once the user cancelled; pending answers are then not sent. */
  isCancelled?(): boolean;
  /** TrueForge summarised older history because the context crossed its threshold. */
  onCompaction?(info: CompactionInfo): void;
}

export interface CompactionInfo {
  phase: 'started' | 'finished';
  /** Estimated context size when compaction fired. */
  contextTokens: number;
  thresholdTokens: number;
  durationMs?: number;
}

export interface TurnOutcome {
  status: string;
  message?: string;
}

/**
 * Model errors worth retrying: a cold local model (`Headers Timeout Error`), a provider
 * that is briefly unreachable, rate limits and 5xx. Seen in Day 1 runs (AGENTS.md section 9).
 */
export function isRetryableModelError(message: string | undefined): boolean {
  if (!message || isQuotaExhausted(message)) return false;
  return /headers timeout|timed? ?out|cannot connect to api|econnrefused|econnreset|socket hang up|\b(429|502|503|504)\b|overloaded|connection failure|network error|failed to fetch/i.test(
    message,
  );
}

/**
 * A daily or plan quota is used up (HTTP 429 that waiting a few seconds cannot fix). Retrying
 * the same model wastes the run; switching to the fallback model can still finish it.
 * Seen: Google "You exceeded your current quota", OpenRouter "free-models-per-day".
 */
export function isQuotaExhausted(message: string | undefined): boolean {
  if (!message) return false;
  return /exceeded your current quota|per.?day|PerDay|daily (limit|quota)|free-models-per-day|insufficient_quota|quota exceeded/i.test(message);
}

function httpStatus(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown; status?: unknown };
  const code = e?.statusCode ?? e?.status;
  return typeof code === 'number' ? code : undefined;
}

/** Parses an agent definition in TrueForge's wire format (snake_case JSON). */
export function parseAgentSpec(raw: unknown): TrueForgeApi.AgentSpec {
  const result = serialization.AgentSpec.parse(raw);
  if (!result.ok) {
    const details = result.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`invalid agent definition: ${details}`);
  }
  return result.value;
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** One-line summary of an event for the output channel. */
export function summarizeEvent(event: StreamEvent): string {
  const thread = 'threadId' in event && event.threadId ? ` [${event.threadId}]` : '';
  switch (event.type) {
    case 'turn.created':
      return `turn.created turnId=${event.turnId}`;
    case 'turn.update':
      return `turn.update status=${event.state.status}`;
    case 'turn.done':
      return `turn.done status=${event.state.status}${
        event.state.status === 'error' ? ` message=${truncate(event.state.message)}` : ''
      }`;
    case 'model.message': {
      const calls = (event.toolCalls ?? []).map((c) => c.function.name).join(', ');
      const model = event.model?.name ? ` model=${event.model.name}` : '';
      return `model.message${thread}${model}${calls ? ` toolCalls=[${calls}]` : ''}`;
    }
    case 'tool.approval_required':
      return `tool.approval_required${thread} toolCallIds=[${event.toolCalls.map((c) => c.id).join(', ')}]`;
    case 'tool.response':
      return `tool.response${thread} toolCallId=${event.toolCallId} content=${truncate(event.content)}`;
    case 'mcp.initialize':
      return `mcp.initialize servers=[${event.mcpServers.map((s) => `${s.name}:${s.transportType ?? '?'}`).join(', ')}]`;
    case 'mcp.auth_required':
      return `mcp.auth_required${thread}`;
    case 'thread.context_compaction_started':
      return `thread.context_compaction_started${thread} contextTokens=${event.trigger.contextTokens} threshold=${event.trigger.thresholdTokens}`;
    case 'thread.context_compaction_finished':
      return `thread.context_compaction_finished${thread} durationMs=${event.durationMs} summaryTokens=${event.usage?.outputTokens ?? '?'}`;
    default:
      return `${event.type}${thread}`;
  }
}

export class TrueForgeClient {
  private readonly client: TrueForge;

  constructor(baseUrl: string) {
    // Local mode has no login, so no token is passed.
    this.client = new TrueForge({ baseUrl, timeoutInSeconds: 600 });
  }

  /** Registers (or re-points) the extension's MCP server under Settings → Connectors. */
  async registerMcpServer(url: string, token: string): Promise<void> {
    await this.client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: 'remote',
        name: MCP_SERVER_NAME,
        description: 'Ripple editor tools served by the VS Code extension: read files and propose reviewed edits.',
        url,
        auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } },
      },
    });
  }

  async createSession(spec: TrueForgeApi.AgentSpec): Promise<string> {
    const { data: session } = await this.client.sessions.create({ agent: { spec } });
    return session.id;
  }

  /**
   * Discovers model context-window limit and max output tokens from TrueForge's
   * model providers configuration.
   */
  async fetchModelMetadata(modelName: string): Promise<{ contextLength?: number; maxOutputTokens?: number } | undefined> {
    try {
      const providers = await this.client.settings.modelProviders.list();
      for (const p of providers.data) {
        const manifest = p.manifest as {
          models?: Array<{
            name?: string;
            modelId?: string;
            properties?: {
              contextLength?: number;
              context_length?: number;
              maxOutputTokens?: number;
              max_output_tokens?: number;
            };
          }>;
        };
        for (const m of manifest.models ?? []) {
          const directMatch = m.name === modelName || m.modelId === modelName;
          const prefixedMatch = `${p.name}/${m.name}` === modelName || `${p.name}/${m.modelId}` === modelName;
          if (directMatch || prefixedMatch) {
            const props = m.properties;
            const contextLength = props?.contextLength ?? props?.context_length;
            const maxOutputTokens = props?.maxOutputTokens ?? props?.max_output_tokens;
            if (contextLength !== undefined || maxOutputTokens !== undefined) {
              return { contextLength, maxOutputTokens };
            }
          }
        }
      }
    } catch {
      // TrueForge may be unreachable or settings not yet initialized
    }
    return undefined;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.client.sessions.cancel(sessionId);
  }

  /**
   * Loads the model before the user's first request: a throwaway session with no tools,
   * one short turn. A cold local model can otherwise exceed TrueForge's ~60 s headers timeout.
   */
  async warmUp(spec: TrueForgeApi.AgentSpec, log: (line: string) => void): Promise<TurnOutcome> {
    const bare: TrueForgeApi.AgentSpec = { ...spec, instructions: 'Reply with the single word OK.', mcpServers: [] };
    const sessionId = await this.createSession(bare);
    return this.runTurn(sessionId, 'OK?', {
      log,
      decide: async () => ({ allow: false, reason: 'warm-up runs no tools' }),
    });
  }

  /**
   * Sends one user message and follows the turn to `turn.done`, answering every
   * approval pause on the same turn (0.185.0 lifecycle).
   */
  async runTurn(sessionId: string, text: string, handlers: TurnHandlers): Promise<TurnOutcome> {
    let stream: AsyncIterable<StreamEvent> = await this.client.sessions.createTurnStream(sessionId, {
      input: [{ type: 'user.message', content: text }],
    });
    let turnId: string | undefined;
    let lastEventId: string | undefined;
    const messages = new Map<string, TrueForgeApi.ModelMessageEvent>();
    const announced = new Map<string, { name: string; args: string }>();
    /** Tells the UI about tool calls of a message once their arguments are complete. */
    const announce = (messageId: string | undefined): void => {
      for (const c of (messageId ? messages.get(messageId)?.toolCalls : undefined) ?? []) {
        if (!c.id || announced.has(c.id)) continue;
        const real = unwrapToolCall(c.function.name, c.function.arguments);
        announced.set(c.id, real);
        handlers.onToolCall?.({ id: c.id, name: real.name, args: real.args, status: 'running' });
      }
    };

    for (;;) {
      const pending: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
      let paused = false;
      let deltaText = '';
      let deltaCount = 0;
      let deltaMessageId: string | undefined;
      const flushDeltas = (): void => {
        if (deltaCount === 0) return;
        // Tool calls arrive in deltas; show them once merged into the base message.
        const calls = (deltaMessageId ? messages.get(deltaMessageId)?.toolCalls : undefined) ?? [];
        const callText = calls.length
          ? ` toolCalls=[${calls.map((c) => `${c.function.name}(${truncate(c.function.arguments, 120)})`).join(', ')}]`
          : '';
        handlers.log(`model.message.delta ×${deltaCount}:${callText} ${truncate(deltaText, 400)}`.trimEnd());
        announce(deltaMessageId);
        deltaText = '';
        deltaCount = 0;
        deltaMessageId = undefined;
      };

      for await (const event of stream) {
        if (event.id) lastEventId = event.id;

        if (isEventDelta(event)) {
          const base = messages.get(event.id);
          if (base) mergeEventDelta(base, event);
          deltaMessageId = event.id;
          deltaText += event.content ?? '';
          deltaCount++;
          if (event.content) handlers.onDelta?.(event.content, 'content');
          for (const call of event.toolCalls ?? []) {
            const fragment = call.function?.arguments;
            if (fragment) handlers.onDelta?.(fragment, 'tool');
          }
          continue;
        }
        flushDeltas();
        handlers.log(summarizeEvent(event));

        if (event.type === 'turn.created') turnId = event.turnId;
        else if (event.type === 'model.message') {
          messages.set(event.id, event);
          announce(event.id);
        }
        else if (event.type === 'tool.approval_required') pending.push(event);
        else if (event.type === 'tool.response') {
          const known = announced.get(event.toolCallId);
          const content = event.content ?? '';
          handlers.onToolCall?.({
            id: event.toolCallId,
            name: known?.name ?? '(tool)',
            args: known?.args ?? '',
            status: content.startsWith('User denied') ? 'denied' : 'done',
            result: truncate(content, 300),
          });
        } else if (event.type === 'thread.context_compaction_started' || event.type === 'thread.context_compaction_finished') {
          handlers.onCompaction?.({
            phase: event.type === 'thread.context_compaction_started' ? 'started' : 'finished',
            contextTokens: event.trigger.contextTokens,
            thresholdTokens: event.trigger.thresholdTokens,
            ...(event.type === 'thread.context_compaction_finished' ? { durationMs: event.durationMs } : {}),
          });
        } else if (event.type === 'turn.update' && event.state.status === 'paused') {
          paused = true;
          break;
        } else if (event.type === 'turn.done') {
          const state = event.state;
          return { status: state.status, ...(state.status === 'error' ? { message: state.message } : {}) };
        }
      }
      flushDeltas();

      if (!paused) return { status: 'stream-ended', message: 'stream closed before turn.done' };
      if (turnId === undefined) throw new Error('turn paused before turn.created');
      if (pending.length === 0) {
        throw new Error('turn paused for input Ripple does not handle yet (no tool.approval_required seen)');
      }

      const answers: TrueForgeApi.TurnUserEventMessage[] = [];
      for (const req of pending) {
        for (const ref of req.toolCalls) {
          const call = messages.get(ref.sourceEventId)?.toolCalls?.find((c) => c.id === ref.id);
          const decision = await handlers.decide({
            toolCallId: ref.id,
            threadId: req.threadId,
            toolName: call?.function.name ?? '(unknown tool)',
            arguments: call?.function.arguments ?? '',
          });
          handlers.log(`→ user.tool_approval toolCallId=${ref.id} ${decision.allow ? 'allow' : 'deny'}`);
          answers.push({
            type: 'user.tool_approval',
            threadId: req.threadId,
            toolCallId: ref.id,
            approval: decision.allow
              ? { status: 'allow' }
              : { status: 'deny', ...(decision.reason ? { reason: decision.reason } : {}) },
          });
        }
      }

      if (handlers.isCancelled?.()) return { status: 'cancelled', message: 'cancelled during review' };
      // Subscribe before sending so no output from the answer is missed.
      stream = await this.client.sessions.subscribeToTurn(
        sessionId,
        turnId,
        lastEventId ? { afterEventId: lastEventId } : {},
      );
      try {
        await this.client.sessions.createTurnEvents(sessionId, turnId, { events: answers });
      } catch (err) {
        // A cancelled turn no longer accepts events (verified: HTTP 409).
        if (httpStatus(err) === 409) {
          handlers.log('createTurnEvents → 409 Turn is not accepting events: treating the turn as cancelled');
          return { status: 'cancelled', message: 'turn no longer accepts events' };
        }
        throw err;
      }
    }
  }
}
