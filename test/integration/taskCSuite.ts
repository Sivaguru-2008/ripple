// Task C (AGENTS.md section 7), inside a real VS Code Extension Development Host on a fresh
// flask 3.1.3 clone: TrueForge is configured with an unreachable endpoint for the inline agent's
// model, and Task A is repeated. Checks: the extension host stays responsive, the fallback model
// takes over with no user action, nothing reaches disk before the user accepts (git status is
// clean while the review is open), the edit is right once accepted, and one undo restores the file.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { RippleApi } from '../../src/extension';
import type { RunResult } from '../../src/trueforge/runner';
import type { Proposal } from '../../src/core/transactions';

const TASK_A =
  "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const HELPERS = 'src/flask/helpers.py';

function root(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'no workspace folder');
  return folder.uri.fsPath.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

function gitStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root(), encoding: 'utf-8' }).trim();
}

function debugFlag(value: string): string {
  return execFileSync(process.env['RIPPLE_TEST_PYTHON'] ?? 'python', ['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'], {
    cwd: root(),
    env: { ...process.env, PYTHONPATH: 'src', FLASK_DEBUG: value, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf-8',
  }).trim();
}

async function selectGetDebugFlag(): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.Uri.file(root()), HELPERS));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const lines = doc.getText().split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('def get_debug_flag'));
  const end = lines.findIndex((l, i) => i > start && l.trimStart().startsWith('return bool('));
  assert.ok(start >= 0 && end > start, 'get_debug_flag not found');
  editor.selection = new vscode.Selection(start, 0, end, lines[end]?.length ?? 0);
  return editor;
}

export async function run(): Promise<void> {
  const outPath = process.env['RIPPLE_RUN_OUT'] ?? '';
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'ripple');
  assert.ok(ext, 'Ripple extension not found');
  const api = (await ext.activate()) as RippleApi;
  assert.equal(gitStatus(), '', 'clone is not clean at start');
  const original = (await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.Uri.file(root()), HELPERS))).getText();
  assert.equal(debugFlag('off'), 'True', 'baseline: off should be True before the edit');

  await selectGetDebugFlag();

  // Responsiveness of the extension host: the longest gap between 50 ms ticks during the run.
  let last = Date.now();
  let maxGap = 0;
  const ticker = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 50);

  const reviews: Proposal[] = [];
  let statusDuringReview: string | undefined;
  const sub = api.onDidOpenReview((p) => {
    reviews.push(p);
    // Nothing is on disk while the fallback's edit waits for review.
    statusDuringReview = gitStatus();
    for (const h of p.hunks) void vscode.commands.executeCommand('ripple.acceptHunk', p.id, h.id);
  });
  const started = Date.now();
  const result = await vscode.commands.executeCommand<RunResult>('ripple.inlineEdit', {
    instruction: TASK_A,
    agentPath: process.env['RIPPLE_TEST_INLINE_AGENT'],
  });
  const durationMs = Date.now() - started;
  clearInterval(ticker);
  sub.dispose();

  const expectFallback = process.env['RIPPLE_EXPECT_FALLBACK'] !== '0';
  const trace = api.logs.filter((l) => /\[run\]|\[fallback\]|\[review\]|turn\.done|Model Error/.test(l));
  for (const l of trace) console.log(l.slice(0, 300));
  console.log(`Task ${expectFallback ? 'C' : 'A'}: status ${result?.status} in ${durationMs} ms; finished on ${result?.model}; fallback ${result?.fallback ? `${result.fallback.from} -> ${result.fallback.to}` : 'none'}`);
  console.log(`Longest extension-host stall during the run: ${maxGap} ms`);
  console.log(`git status while the review was open: ${statusDuringReview === '' ? '(clean)' : statusDuringReview}`);

  // Task C expects the fallback to take over; the same check run as Task A expects none.
  if (expectFallback) assert.ok(result?.fallback, `the fallback model did not take over: ${result?.status} ${result?.message ?? ''}`);
  else assert.equal(result?.fallback, undefined, `the primary model failed: ${result?.message ?? ''}`);
  assert.equal(result.status, 'done', `run did not finish: ${result.message ?? ''}`);
  assert.equal(reviews.length, 1, 'expected exactly one review');
  assert.equal(statusDuringReview, '', 'files changed on disk before the review was accepted');
  assert.ok(maxGap < 1000, `the extension host stalled for ${maxGap} ms`);

  const offFlag = debugFlag('off');
  console.log(`FLASK_DEBUG=off → ${offFlag}; n → ${debugFlag('n')}; OFF → ${debugFlag('OFF')}; 1 → ${debugFlag('1')}`);
  assert.equal(offFlag, 'False', 'Task A verification failed after the edit');
  assert.equal(debugFlag('n'), 'False', "'n' is not treated as false");
  assert.equal(debugFlag('OFF'), 'False', "'OFF' is not treated as false (case)");
  assert.equal(debugFlag('1'), 'True', "'1' is no longer treated as true");
  // The instruction also asks for the docstring to list every false value.
  const edited = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith('helpers.py'))?.getText() ?? '';
  const def = edited.indexOf('def get_debug_flag');
  const docstring = /("""|''')([\s\S]*?)\1/.exec(edited.slice(def))?.[2] ?? '';
  const missing = ['0', 'false', 'no', 'off', 'n'].filter((v) => !new RegExp(`(?<![A-Za-z0-9_])${v}(?![A-Za-z0-9_])`, 'i').test(docstring));
  console.log(`docstring lists: ${missing.length ? `all but ${missing.join(', ')}` : 'every false value'}; hunks: ${reviews[0]!.hunks.length}`);
  assert.deepEqual(missing, [], `the docstring does not list ${missing.join(' and ')}`);

  assert.equal(await vscode.commands.executeCommand('ripple.undoLastChange'), true, 'undo failed');
  const statusAfterUndo = gitStatus();
  console.log(`git status after undo: ${statusAfterUndo || '(clean)'}`);
  assert.equal(statusAfterUndo, '', 'git status not clean after undo');
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith('helpers.py'));
  assert.equal(doc?.getText(), original, 'helpers.py not restored by undo');

  if (outPath) {
    writeFileSync(
      outPath,
      JSON.stringify({ durationMs, finishedOn: result.model, fallback: result.fallback, maxGapMs: maxGap, statusDuringReview, offFlag, success: true }, null, 2),
    );
  }
  console.log(`\n=== TASK ${expectFallback ? 'C' : 'A'} PASSED ===\n`);
}
