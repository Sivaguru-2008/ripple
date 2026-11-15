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

export type ApprovalDecision = { allow: true } | { allow: false; reason?: string };

export interface TurnHandlers {
  log(line: string): void;
  decide(call: PendingToolCall): Promise<ApprovalDecision>;
}

export interface TurnOutcome {
  status: string;
  message?: string;
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

  async cancel(sessionId: string): Promise<void> {
    await this.client.sessions.cancel(sessionId);
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

    for (;;) {
      const pending: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
      let paused = false;
      let deltaText = '';
      let deltaCount = 0;
      const flushDeltas = (): void => {
        if (deltaCount === 0) return;
        handlers.log(`model.message.delta ×${deltaCount}: ${truncate(deltaText, 400)}`);
        deltaText = '';
        deltaCount = 0;
      };

      for await (const event of stream) {
        if (event.id) lastEventId = event.id;

        if (isEventDelta(event)) {
          const base = messages.get(event.id);
          if (base) mergeEventDelta(base, event);
          deltaText += event.content ?? '';
          deltaCount++;
          continue;
        }
        flushDeltas();
        handlers.log(summarizeEvent(event));

        if (event.type === 'turn.created') turnId = event.turnId;
        else if (event.type === 'model.message') messages.set(event.id, event);
        else if (event.type === 'tool.approval_required') pending.push(event);
        else if (event.type === 'turn.update' && event.state.status === 'paused') {
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

      // Subscribe before sending so no output from the answer is missed.
      stream = await this.client.sessions.subscribeToTurn(
        sessionId,
        turnId,
        lastEventId ? { afterEventId: lastEventId } : {},
      );
      await this.client.sessions.createTurnEvents(sessionId, turnId, { events: answers });
    }
  }
}
