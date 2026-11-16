import * as vscode from 'vscode';
import { runShellCommand } from './core/command';
import { describePins, parseMentions, resolveMentions } from './core/mentions';
import type { Pin } from './core/retrieve';
import { resolveInWorkspace } from './core/paths';
import { mineCochange } from './core/cochange';
import { calculateRetrievalBudget, type ModelContextConfig } from './core/budget';
import { retrieve, type RetrieveResult } from './core/retrieve';
import { searchWorkspace } from './core/search';
import { TransactionManager, type FileChange, type Proposal, type TextReplacement } from './core/transactions';
import { diskSource } from './core/workspaceFiles';
import { startMcpServer, type RunningMcpServer } from './mcp/server';
import { TrueForgeClient, parseAgentSpec, type ApprovalDecision, type PendingToolCall } from './trueforge/client';
import { Runner, type RunResult } from './trueforge/runner';
import { AgentPanelProvider } from './ui/panel';
import { ReviewController } from './ui/review';

const SMOKE_PROMPT = 'Read README.md, then propose adding one line to it.';

let mcp: RunningMcpServer | undefined;

/** Test-only options; the command palette and keybinding pass nothing. */
interface AgentRunOptions {
  instruction?: string;
  agentPath?: string;
  /** Test-only: answers the run_command approval without the notification. */
  approveCommands?: 'allow' | 'deny';
}

interface CommandOptions {
  /** Agent definition to use instead of the bundled one. */
  agentPath?: string;
  /** Inline edit instruction (skips the input box). */
  instruction?: string;
}

/** What `activate` returns; used by the integration test. */
export interface RippleApi {
  tx: TransactionManager;
  onDidOpenReview: vscode.Event<Proposal>;
  onDidStream: vscode.Event<string>;
  /** Every line written to the Ripple output channel. */
  logs: string[];
  /** The most recent retrieve_context result (what the Receipt section shows). */
  lastReceipt(): RetrieveResult | undefined;
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('open a folder first');
  return folder.uri.fsPath;
}

function fileUri(relPath: string): vscode.Uri {
  return vscode.Uri.file(resolveInWorkspace(workspaceRoot(), relPath));
}

function relPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

/** Current text of a workspace file: the open (possibly unsaved) buffer if any, else disk. */
async function readText(path: string): Promise<string> {
  const uri = fileUri(path);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
}

/** Applies all replacements as ONE WorkspaceEdit (one undo step), then saves. */
async function applyEdits(path: string, baseText: string, edits: TextReplacement[]): Promise<'ok' | 'changed'> {
  const uri = fileUri(path);
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.getText() !== baseText) return 'changed';
  const edit = new vscode.WorkspaceEdit();
  for (const e of edits) edit.replace(uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
  if (!(await vscode.workspace.applyEdit(edit))) return 'changed';
  await doc.save();
  return 'ok';
}

/** Applies all replacements across multiple files as ONE atomic WorkspaceEdit, then saves all. */
async function applyAll(changes: FileChange[]): Promise<'ok' | { changed: string }> {
  const docs: { doc: vscode.TextDocument; path: string }[] = [];
  for (const c of changes) {
    const uri = fileUri(c.path);
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.getText() !== c.baseText) return { changed: c.path };
    docs.push({ doc, path: c.path });
  }
  const edit = new vscode.WorkspaceEdit();
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]!;
    const doc = docs[i]!.doc;
    for (const e of c.edits) {
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
    }
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    return { changed: changes[0]?.path ?? 'workspace' };
  }
  for (const { doc } of docs) {
    await doc.save();
  }
  return 'ok';
}

function baseUrl(): string {
  return vscode.workspace.getConfiguration('ripple').get<string>('trueforgeBaseUrl', 'http://localhost:8790');
}

async function askApproval(call: PendingToolCall): Promise<ApprovalDecision> {
  let detail = call.arguments;
  try {
    detail = JSON.stringify(JSON.parse(call.arguments), null, 2);
  } catch {
    // keep raw arguments
  }
  let command: string | undefined;
  try {
    const parsed = JSON.parse(call.arguments) as { command?: unknown };
    if (typeof parsed.command === 'string') command = parsed.command;
  } catch {
    // not JSON
  }
  const choice = await vscode.window.showInformationMessage(
    command !== undefined
      ? `Ripple: the agent wants to run \`${command}\` in the workspace. Accepted hunks are written to disk first. Allow it?`
      : `Ripple: the agent wants to run ${call.toolName}. Allow it?`,
    { modal: false, detail },
    'Allow',
    'Deny',
  );
  return choice === 'Allow' ? { allow: true } : { allow: false, reason: 'denied by user' };
}

async function loadSpec(context: vscode.ExtensionContext, name: string, override?: string) {
  const uri = override ? vscode.Uri.file(override) : vscode.Uri.joinPath(context.extensionUri, 'agents', name);
  const raw: unknown = JSON.parse(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)));
  return parseAgentSpec(raw);
}

function inlineMessage(path: string, languageId: string, startLine: number, endLine: number, selected: string, instruction: string): string {
  return [
    `File: ${path} (selected lines ${startLine + 1}-${endLine}).`,
    `Language: ${languageId}.`,
    '<selected_lines>',
    selected,
    '</selected_lines>',
    `Instruction: ${instruction}`,
    'Use the replace_selection tool (a real tool call, not text) with new_text = the complete rewritten selected lines.',
  ].join('\n');
}

export async function activate(context: vscode.ExtensionContext): Promise<RippleApi> {
  let lastReceipt: RetrieveResult | undefined;
  const output = vscode.window.createOutputChannel('Ripple');
  context.subscriptions.push(output);
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
    output.appendLine(`${new Date().toISOString().slice(11, 23)} ${line}`);
  };
  const streamEmitter = new vscode.EventEmitter<string>();
  context.subscriptions.push(streamEmitter);

  let review!: ReviewController;
  const tx = new TransactionManager({
    readText,
    applyEdits,
    applyAll,
    review: (p) => review.show(p, fileUri(p.path)),
  });
  review = new ReviewController(tx, log);
  context.subscriptions.push(review);

  let panelProvider: AgentPanelProvider | undefined;
  /** Files and symbols the user @mentioned, per run: always part of that run's context. */
  const pinsByRun = new Map<string, Pin[]>();
  /** Adaptive retrieval budget resolved per run based on the active model. */
  const budgetByRun = new Map<string, number>();
  /** Active model name per run. */
  const modelByRun = new Map<string, string>();
  const openBufferText = (p: string): string | undefined => {
    try {
      const target = fileUri(p).fsPath;
      return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === target && d.isDirty)?.getText();
    } catch {
      return undefined;
    }
  };
  let panelRunId: string | undefined;
  // Per-file summary of the current agent run, redrawn whenever a hunk changes state.
  tx.onDidChange = () => {
    if (!panelRunId) return;
    const byFile = new Map<string, Record<string, number>>();
    for (const p of tx.proposalsFor(panelRunId)) {
      const counts = byFile.get(p.path) ?? {};
      for (const h of p.hunks) {
        const key =
          h.status === 'held' || h.status === 'accepted' ? 'accepted, staged' : h.status === 'failed' ? 'not written' : h.status === 'applied' ? 'written' : h.status;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      byFile.set(p.path, counts);
    }
    const files = [...byFile].map(([path, counts]) => ({
      path,
      hunksCount: Object.values(counts).reduce((a, b) => a + b, 0),
      detail: Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', '),
    }));
    panelProvider?.setStaged({ files, totalHunks: files.reduce((n, x) => n + x.hunksCount, 0) });
  };

  mcp = await startMcpServer({
    checkRun: (token) => void tx.requireActive(token),
    readText: async (p, runToken) => {
      if (runToken) {
        return tx.readForRun(runToken, p);
      }
      return readText(p);
    },
    execute: (token, tool, args) => tx.execute(token, tool, args),
    searchWorkspace: async (query, glob) => {
      try {
        const root = workspaceRoot();
        const res = await searchWorkspace(root, query, glob);
        return { text: res.formatted, isError: false };
      } catch (err) {
        return { text: `search failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
    retrieveContext: async (runToken, task, budgetTokens) => {
      try {
        const root = workspaceRoot();
        // Stale or unknown runs are rejected here, like every other tool.
        const run = tx.requireActive(runToken);
        const source = diskSource(root, (p) => tx.stagedText(run.id, p) ?? openBufferText(p));
        // Pins: what the user @mentioned in the prompt, plus any mention the agent passes on.
        const fromTask = await resolveMentions(parseMentions(task), source);
        const userPins = pinsByRun.get(run.id) ?? [];
        const resolved = { pins: [...userPins, ...fromTask.pins.filter((p) => !userPins.some((u) => u.path === p.path && u.startLine === p.startLine))] };
        // Mined once per workspace and cached; an unavailable history only drops this signal.
        const cochange = await mineCochange(root);
        const runBudget = budgetByRun.get(run.id);
        const modelName = modelByRun.get(run.id);
        const finalBudget = runBudget !== undefined
          ? (budgetTokens ? Math.min(budgetTokens, runBudget) : runBudget)
          : budgetTokens;
        const res = await retrieve(task, source, { budgetTokens: finalBudget, modelName, pins: resolved.pins, cochange });
        lastReceipt = res;
        panelProvider?.setReceipt(res);
        return { text: res.text, isError: false };
      } catch (err) {
        return { text: `retrieve failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
    runCommand: async (runToken, command) => {
      try {
        const run = tx.requireActive(runToken);
        let note = '';
        if (run.deferred) {
          // The command must test the accepted edits, so they are written first, as one edit.
          const committed = await tx.commit(run.id);
          if (!committed.ok) {
            return { text: `The command was not run. ${committed.error}`, isError: true };
          }
          if (committed.files.length) {
            note = `Before the command ran, ${committed.hunks} accepted hunk(s) were written to disk: ${committed.files.join(', ')}.\n`;
            log(`[command] ${run.id}: wrote ${committed.hunks} accepted hunk(s) in ${committed.files.length} file(s) before the command`);
          }
        }
        const root = workspaceRoot();
        const res = await runShellCommand(root, command);
        log(`[command] ${run.id}: \`${command}\` → ${res.isError ? `failed: ${res.text.slice(-600).replace(/\s+/g, ' ')}` : 'ok'}`);
        return { text: note + res.text, isError: res.isError };
      } catch (err) {
        return { text: `command failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
    log,
  });
  log(`[mcp] listening on ${mcp.url}/<run token>`);

  const tf = new TrueForgeClient(baseUrl());
  const runner = new Runner({
    tx,
    tf,
    mcpUrlForRun: (token) => mcp!.urlForRun(token),
    mcpBearer: mcp.token,
    log,
    onRunEnded: (runId, state) => {
      if (state !== 'finished') review.closeRun(runId);
    },
  });

  panelProvider = new AgentPanelProvider(
    context.extensionUri,
    async (prompt: string) => {
      await vscode.commands.executeCommand('ripple.agentRun', { instruction: prompt });
    },
    async () => {
      await vscode.commands.executeCommand('ripple.cancel');
    },
    async () => {
      await vscode.commands.executeCommand('ripple.undoLastChange');
    },
    baseUrl(),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const reportRegistrationError = (err: unknown): void => {
    log(`[trueforge] could not register MCP server at ${baseUrl()}: ${String(err)}`);
    if (String(err).includes('Outbound URL blocked')) {
      log(`[trueforge] fix: restart TrueForge with OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' (see README)`);
    }
  };

  // Warm-up: load the inline model through TrueForge before the first request, so a cold
  // local model does not hit TrueForge's headers timeout on the user's first edit.
  if (vscode.workspace.getConfiguration('ripple').get<boolean>('warmUp', true)) {
    void (async () => {
      try {
        const spec = await loadSpec(context, 'ripple-inline.json');
        const started = Date.now();
        const outcome = await tf.warmUp(spec, () => undefined);
        log(`[warm-up] ${spec.model.name}: ${outcome.status} in ${Date.now() - started} ms${outcome.message ? ` (${outcome.message})` : ''}`);
      } catch (err) {
        log(`[warm-up] failed (not fatal): ${String(err)}`);
      }
    })();
  }

  /** Runs one request with a cancellable progress notification that shows the stream. */
  const runWithProgress = (title: string, start: (onDelta: (t: string) => void) => Promise<RunResult>): Promise<RunResult> =>
    Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Ripple: ${title}`, cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => void runner.cancel());
          let streamed = '';
          let last = 0;
          return start((text) => {
            streamed += text;
            streamEmitter.fire(text);
            const now = Date.now();
            if (now - last > 150) {
              last = now;
              progress.report({ message: streamed.replace(/\s+/g, ' ').slice(-80) });
            }
          });
        },
      ),
    );

  const finishMessage = (result: RunResult): void => {
    if (result.status === 'error') {
      void vscode.window.showErrorMessage(`Ripple: the run failed after ${result.attempts} attempt(s): ${result.message ?? 'unknown error'}. Nothing staged was written.`);
    } else if (result.status === 'cancelled') {
      void vscode.window.showInformationMessage('Ripple: cancelled. Staged changes were discarded.');
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('ripple.inlineEdit', async (options?: CommandOptions) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showWarningMessage('Ripple: select the code to edit first.');
        return undefined;
      }
      if (runner.busy) {
        void vscode.window.showWarningMessage('Ripple: a run is in progress. Cancel it first (Ripple: Cancel).');
        return undefined;
      }
      const instruction =
        options?.instruction ??
        (await vscode.window.showInputBox({ prompt: 'Ripple: how should the selected code change?', ignoreFocusOut: true }));
      if (!instruction) return undefined;

      const doc = editor.document;
      const sel = editor.selection;
      const startLine = sel.start.line;
      const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      const lines = doc.getText().split(/\r?\n/);
      const selected = lines.slice(startLine, endLine).join('\n');
      const path = relPath(doc.uri);
      output.show(true);
      log(`[inline] ${path} lines ${startLine + 1}-${endLine}: ${instruction}`);
      try {
        const spec = await loadSpec(context, 'ripple-inline.json', options?.agentPath);
        const fallbackModel = vscode.workspace.getConfiguration('ripple').get<string>('fallbackModel');
        const fallbackSpec = fallbackModel && fallbackModel !== spec.model.name ? { ...spec, model: { ...spec.model, name: fallbackModel } } : undefined;
        const result = await runWithProgress('inline edit', (onDelta) =>
          runner.run({
            spec,
            fallbackSpec,
            message: inlineMessage(path, doc.languageId, startLine, endLine, selected, instruction),
            selection: { path, startLine, endLine, text: selected },
            nudge:
              'You did not call the replace_selection tool, so nothing was proposed. Call the replace_selection tool now as a real tool call (not JSON or Markdown text) with the complete rewritten selected lines.',
            decideOther: askApproval,
            onDelta: (text) => onDelta(text),
            onFallback: (fromModel, toModel, reason) => {
              log(`[fallback] inline edit switched from ${fromModel} to ${toModel} (${reason})`);
            },
          }),
        );
        log(`[inline] result: ${result.status}${result.message ? ` (${result.message})` : ''}`);
        finishMessage(result);
        return result;
      } catch (err) {
        reportRegistrationError(err);
        void vscode.window.showErrorMessage(`Ripple: ${String(err)}`);
        return { status: 'error', message: String(err), runIds: [], attempts: 0 } satisfies RunResult;
      }
    }),

    vscode.commands.registerCommand('ripple.cancel', async () => {
      if (!(await runner.cancel())) void vscode.window.showInformationMessage('Ripple: nothing to cancel.');
    }),

    vscode.commands.registerCommand('ripple.acceptHunk', (proposalId: string, hunkId: string) => {
      review.decide(proposalId, hunkId, true);
    }),
    vscode.commands.registerCommand('ripple.rejectHunk', async (proposalId: string, hunkId: string, reason?: string) => {
      const why =
        reason ??
        (await vscode.window.showInputBox({ prompt: 'Why reject this hunk? (optional; the agent is told)', ignoreFocusOut: true }));
      if (why === undefined) return; // Escape: no decision
      review.decide(proposalId, hunkId, false, why);
    }),
    vscode.commands.registerCommand('ripple.acceptAllHunks', (proposalId: string) => {
      for (const id of review.pending(proposalId)) review.decide(proposalId, id, true);
    }),
    vscode.commands.registerCommand('ripple.rejectAllHunks', async (proposalId: string, reason?: string) => {
      const why = reason ?? (await vscode.window.showInputBox({ prompt: 'Why reject these changes? (optional)', ignoreFocusOut: true }));
      if (why === undefined) return;
      for (const id of review.pending(proposalId)) review.decide(proposalId, id, false, why);
    }),

    vscode.commands.registerCommand('ripple.undoLastChange', async () => {
      const last = tx.lastApplied;
      if (!last) {
        void vscode.window.showInformationMessage('Ripple: no applied change to undo.');
        return false;
      }
      // One WorkspaceEdit restores every file the run wrote.
      const edit = new vscode.WorkspaceEdit();
      const docs: vscode.TextDocument[] = [];
      for (const f of last.files) {
        const uri = fileUri(f.path);
        const doc = await vscode.workspace.openTextDocument(uri);
        if (doc.getText() !== f.after) {
          void vscode.window.showWarningMessage(`Ripple: ${f.path} changed after Ripple's edit; use Ctrl+Z in the editor instead.`);
          return false;
        }
        edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), f.before);
        docs.push(doc);
      }
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) for (const doc of docs) await doc.save();
      tx.lastApplied = undefined;
      log(`[undo] ${last.files.map((f) => f.path).join(', ')} restored to the text before ${last.runId}`);
      return ok;
    }),

    vscode.commands.registerCommand('ripple.agentRun', async (options?: AgentRunOptions) => {
      if (runner.busy) {
        void vscode.window.showWarningMessage('Ripple: a run is in progress. Cancel it first (Ripple: Cancel).');
        return undefined;
      }
      const instruction =
        options?.instruction ??
        (await vscode.window.showInputBox({ prompt: 'Ripple: what should the agent build or change?', ignoreFocusOut: true }));
      if (!instruction) return undefined;

      output.show(true);
      log(`[agent] prompt: ${instruction}`);
      panelProvider?.resetRun();
      panelRunId = undefined;

      try {
        const spec = await loadSpec(context, 'ripple-agent.json', options?.agentPath);
        const modelName = spec.model.name;
        let modelMeta: { contextLength?: number; maxOutputTokens?: number } | undefined;
        try {
          modelMeta = await tf.fetchModelMetadata(modelName);
        } catch {
          // offline or unconfigured
        }
        const perModelConfig = vscode.workspace.getConfiguration('ripple').get<Record<string, ModelContextConfig>>('perModelConfig');
        const adaptiveBudget = calculateRetrievalBudget({
          modelName,
          contextWindow: modelMeta?.contextLength,
          maxOutputTokens: modelMeta?.maxOutputTokens,
          perModelConfig,
        });
        log(`[budget] model ${modelName}: contextWindow=${adaptiveBudget.contextWindow}, reserved=${adaptiveBudget.reservedTokens}, retrievalBudget=${adaptiveBudget.effectiveBudget} (source: ${adaptiveBudget.source})`);

        const fallbackModel = vscode.workspace.getConfiguration('ripple').get<string>('fallbackModel');
        const fallbackSpec = fallbackModel && fallbackModel !== spec.model.name ? { ...spec, model: { ...spec.model, name: fallbackModel } } : undefined;

        // @file and @symbol mentions in the prompt are resolved now and pinned into context.
        const mentioned = await resolveMentions(parseMentions(instruction), diskSource(workspaceRoot(), openBufferText));
        if (mentioned.pins.length || mentioned.unresolved.length) log(`[agent] mentions:\n${describePins(mentioned)}`);
        const message =
          mentioned.pins.length || mentioned.unresolved.length
            ? `${instruction}\n\nPinned by the user (always included by retrieve_context):\n${describePins(mentioned)}`
            : instruction;
        const approveCommand = async (call: PendingToolCall): Promise<ApprovalDecision> => {
          if (options?.approveCommands) {
            log(`[approval] ${call.toolName} ${call.arguments}: ${options.approveCommands} (test option)`);
            return options.approveCommands === 'allow' ? { allow: true } : { allow: false, reason: 'denied by user' };
          }
          return askApproval(call);
        };
        const result = await runWithProgress('agent task', (onDelta) =>
          runner.run({
            spec,
            fallbackSpec,
            message,
            deferred: true,
            decideOther: approveCommand,
            onFallback: (fromModel, toModel, reason) => {
              log(`[fallback] agent task switched from ${fromModel} to ${toModel} (${reason})`);
              panelProvider?.setStatus('running', `Switched to fallback model ${toModel}`);
            },
            onSession: (runId, sessionId) => {
              panelRunId = runId;
              pinsByRun.set(runId, mentioned.pins);
              modelByRun.set(runId, modelName);
              budgetByRun.set(runId, adaptiveBudget.effectiveBudget);
              panelProvider?.setStatus('running', undefined, sessionId);
            },
            onDelta: (text, kind) => {
              onDelta(text);
              // Tool-call arguments are shown as tool cards, not as assistant text.
              if (kind === 'content') panelProvider?.appendStreamedDelta(text);
            },
            onToolCall: (call) => {
              panelProvider?.recordToolCall({ id: call.id, name: call.name, args: call.args, status: call.status, ...(call.result ? { resultText: call.result } : {}) });
            },
          }),
        );
        log(`[agent] result: ${result.status}${result.message ? ` (${result.message})` : ''}`);
        panelProvider?.setStatus(result.status, result.message);
        finishMessage(result);
        return result;
      } catch (err) {
        reportRegistrationError(err);
        panelProvider?.setStatus('error', String(err));
        void vscode.window.showErrorMessage(`Ripple: ${String(err)}`);
        return { status: 'error', message: String(err), runIds: [], attempts: 0 } satisfies RunResult;
      }
    }),

    // Day 1 smoke test, kept as a regression check of the approval round trip.
    vscode.commands.registerCommand('ripple.smokeTest', async (options?: CommandOptions) => {
      output.show(true);
      const lines: string[] = [];
      const record = (line: string): void => {
        lines.push(line);
        log(line);
      };
      const smokeRunner = new Runner({
        tx,
        tf,
        mcpUrlForRun: (token) => mcp!.urlForRun(token),
        mcpBearer: mcp!.token,
        log: record,
        onRunEnded: (runId, state) => {
          if (state !== 'finished') review.closeRun(runId);
        },
      });
      try {
        const spec = await loadSpec(context, 'ripple-agent.json', options?.agentPath);
        const outcome = await smokeRunner.run({ spec, message: SMOKE_PROMPT, decideOther: askApproval, attempts: 1 });
        return { outcome, lines };
      } catch (err) {
        record(`[trueforge] smoke test failed: ${String(err)}`);
        return { outcome: { status: 'error', message: String(err) }, lines };
      }
    }),
  );

  return { tx, onDidOpenReview: review.onDidOpen, onDidStream: streamEmitter.event, logs, lastReceipt: () => lastReceipt };
}

export async function deactivate(): Promise<void> {
  await mcp?.close();
  mcp = undefined;
}
