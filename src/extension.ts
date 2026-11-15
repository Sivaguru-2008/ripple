import * as vscode from 'vscode';
import { resolveInWorkspace } from './core/paths';
import { startMcpServer, type RunningMcpServer } from './mcp/server';
import { TrueForgeClient, parseAgentSpec, type ApprovalDecision, type PendingToolCall } from './trueforge/client';

const SMOKE_PROMPT = 'Read README.md, then propose adding one line to it.';

let mcp: RunningMcpServer | undefined;

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('open a folder first');
  return folder.uri.fsPath;
}

/** Current text of a workspace file: the open (possibly unsaved) buffer if any, else disk. */
async function readText(relPath: string): Promise<string> {
  const uri = vscode.Uri.file(resolveInWorkspace(workspaceRoot(), relPath));
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
}

function baseUrl(): string {
  return vscode.workspace.getConfiguration('ripple').get<string>('trueforgeBaseUrl', 'http://127.0.0.1:8790');
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Ripple');
  context.subscriptions.push(output);
  const log = (line: string): void => output.appendLine(`${new Date().toISOString().slice(11, 23)} ${line}`);

  mcp = await startMcpServer({
    readText,
    onProposal: (p) => log(`[mcp] propose_write epoch=${p.epoch} path=${p.path} edits=${JSON.stringify(p.edits)}`),
    log,
  });
  log(`[mcp] listening on ${mcp.url}`);

  const registration = (async () => {
    const tf = new TrueForgeClient(baseUrl());
    await tf.registerMcpServer(mcp!.url, mcp!.token);
    log(`[trueforge] registered MCP server 'ripple' at ${baseUrl()}`);
  })().catch((err: unknown) => {
    log(`[trueforge] could not register MCP server at ${baseUrl()}: ${String(err)}`);
    throw err;
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('ripple.smokeTest', async () => {
      output.show(true);
      const tf = new TrueForgeClient(baseUrl());
      try {
        await registration.catch(() => tf.registerMcpServer(mcp!.url, mcp!.token));
        const specUri = vscode.Uri.joinPath(context.extensionUri, 'agents', 'ripple-agent.json');
        const raw: unknown = JSON.parse(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(specUri)));
        const spec = parseAgentSpec(raw);
        const sessionId = await tf.createSession(spec);
        log(`[trueforge] session ${sessionId} (model ${spec.model.name})`);
        log(`[trueforge] → user.message "${SMOKE_PROMPT}"`);
        const outcome = await tf.runTurn(sessionId, SMOKE_PROMPT, { log, decide: askApproval });
        log(`[trueforge] turn finished: ${outcome.status}${outcome.message ? ` (${outcome.message})` : ''}`);
      } catch (err) {
        log(`[trueforge] smoke test failed: ${String(err)}`);
        void vscode.window.showErrorMessage(`Ripple smoke test failed: ${String(err)}`);
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  await mcp?.close();
  mcp = undefined;
}
