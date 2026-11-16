import * as vscode from 'vscode';
import { resolveInWorkspace } from './core/paths';
import { TransactionManager, type Proposal, type TextReplacement } from './core/transactions';
import { startMcpServer, type RunningMcpServer } from './mcp/server';
import { TrueForgeClient, parseAgentSpec, type ApprovalDecision, type PendingToolCall } from './trueforge/client';
import { Runner, type RunResult } from './trueforge/runner';
import { ReviewController } from './ui/review';

const SMOKE_PROMPT = 'Read README.md, then propose adding one line to it.';

let mcp: RunningMcpServer | undefined;

/** Test-only options; the command palette and keybinding pass nothing. */
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
  const choice = await vscode.window.showInformationMessage(
    `Ripple: the agent wants to run ${call.toolName}. Allow it?`,
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
    review: (p) => review.show(p, fileUri(p.path)),
  });
  review = new ReviewController(tx, log);
  context.subscriptions.push(review);

  mcp = await startMcpServer({
    checkRun: (token) => void tx.requireActive(token),
    readText,
    execute: (token, tool, args) => tx.execute(token, tool, args),
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
        const result = await runWithProgress('inline edit', (onDelta) =>
          runner.run({
            spec,
            message: inlineMessage(path, doc.languageId, startLine, endLine, selected, instruction),
            selection: { path, startLine, endLine, text: selected },
            nudge:
              'You did not call the replace_selection tool, so nothing was proposed. Call the replace_selection tool now as a real tool call (not JSON or Markdown text) with the complete rewritten selected lines.',
            decideOther: askApproval,
            onDelta: (text) => onDelta(text),
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
      const uri = fileUri(last.path);
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.getText() !== last.after) {
        void vscode.window.showWarningMessage(`Ripple: ${last.path} changed after Ripple's edit; use Ctrl+Z in the editor instead.`);
        return false;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), last.before);
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) await doc.save();
      tx.lastApplied = undefined;
      log(`[undo] ${last.path} restored to its text before ${last.runId}`);
      return ok;
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

  return { tx, onDidOpenReview: review.onDidOpen, onDidStream: streamEmitter.event, logs };
}

export async function deactivate(): Promise<void> {
  await mcp?.close();
  mcp = undefined;
}
