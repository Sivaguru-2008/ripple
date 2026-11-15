// Runs inside the real VS Code Extension Development Host (see runTest.mjs).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface SmokeResult {
  outcome: { status: string; message?: string };
  lines: string[];
}

async function smoke(approve: 'allow' | 'deny'): Promise<SmokeResult> {
  const agentPath = process.env['RIPPLE_TEST_AGENT'];
  assert.ok(agentPath, 'RIPPLE_TEST_AGENT not set');
  const result = await vscode.commands.executeCommand<SmokeResult>('ripple.smokeTest', { agentPath, approve });
  console.log(`---- smoke test (${approve}) ----\n${result.lines.join('\n')}`);
  return result;
}

async function readme(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'no workspace folder');
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'README.md'));
  return new TextDecoder('utf-8').decode(bytes);
}

function has(lines: string[], pattern: RegExp): boolean {
  return lines.some((l) => pattern.test(l));
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'ripple');
  assert.ok(ext, 'Ripple extension not found');
  await ext.activate();
  const before = await readme();

  const allowed = await smoke('allow');
  assert.equal(allowed.outcome.status, 'done', allowed.outcome.message);
  assert.ok(has(allowed.lines, /^mcp\.initialize servers=\[ripple:/), 'MCP server not initialised');
  assert.ok(has(allowed.lines, /toolCalls=\[read_file\(/), 'no read_file call');
  assert.ok(has(allowed.lines, /^tool\.approval_required/), 'no approval event');
  assert.ok(has(allowed.lines, /^turn\.update status=paused/), 'turn did not pause');
  assert.ok(has(allowed.lines, /user\.tool_approval .* allow/), 'approval not sent');
  assert.ok(has(allowed.lines, /^tool\.response .*staged: \d+ edit/), 'propose_write did not run');
  assert.equal(await readme(), before, 'README changed on disk');

  const denied = await smoke('deny');
  assert.equal(denied.outcome.status, 'done', denied.outcome.message);
  assert.ok(has(denied.lines, /user\.tool_approval .* deny/), 'denial not sent');
  assert.ok(has(denied.lines, /User denied tool call/), 'agent was not told about the denial');
  assert.ok(!has(denied.lines, /staged: \d+ edit/), 'propose_write ran despite deny');
  assert.equal(await readme(), before, 'README changed on disk');
}
