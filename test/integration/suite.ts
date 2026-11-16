// Runs inside the real VS Code Extension Development Host (see runTest.mjs), on a fresh
// clone of pallets/flask at 3.1.3. Covers Task A: inline edit with per-hunk review, the
// verification command, one undo, and cancel leaving `git status` clean.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import type { RippleApi } from '../../src/extension';
import type { RunResult } from '../../src/trueforge/runner';
import type { Proposal } from '../../src/core/transactions';

const TASK_A =
  "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const HELPERS = 'src/flask/helpers.py';
const mock = process.env['RIPPLE_TEST_MOCK'] === '1';

function root(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'no workspace folder');
  return folder.uri.fsPath;
}

function gitStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root(), encoding: 'utf-8' }).trim();
}

/** The Task A verification command from AGENTS.md section 7. */
function debugFlag(value: string): string {
  return execFileSync(process.env['RIPPLE_TEST_PYTHON'] ?? 'python', ['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'], {
    cwd: root(),
    env: { ...process.env, PYTHONPATH: 'src', FLASK_DEBUG: value, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf-8',
  }).trim();
}

/** The docstring of get_debug_flag: the text between the first pair of triple quotes after its def line. */
function debugFlagDocstring(source: string): string {
  const def = source.indexOf('def get_debug_flag');
  assert.ok(def >= 0, 'get_debug_flag not found after the edit');
  const m = /("""|''')([\s\S]*?)\1/.exec(source.slice(def));
  assert.ok(m, 'get_debug_flag has no docstring after the edit');
  return m[2]!;
}

/** True when `value` appears in the text as a listed value (a whole word, quoted or not), in any case. */
function listsValue(text: string, value: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${value}(?![A-Za-z0-9_])`, 'i').test(text);
}

/** Opens helpers.py and selects get_debug_flag (def line through its return line). */
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

function inlineEdit(instruction: string): Thenable<RunResult> {
  return vscode.commands.executeCommand<RunResult>('ripple.inlineEdit', {
    instruction,
    agentPath: process.env['RIPPLE_TEST_INLINE_AGENT'],
  });
}

function step(name: string): void {
  console.log(`\n==== ${name} ====`);
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'ripple');
  assert.ok(ext, 'Ripple extension not found');
  const api = (await ext.activate()) as RippleApi;
  assert.equal(gitStatus(), '', 'clone is not clean at start');
  const original = (await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.Uri.file(root()), HELPERS))).getText();
  assert.equal(debugFlag('off'), 'True', 'baseline: off should be True before the edit');

  // ---- 1. Cancel mid-generation leaves the workspace clean.
  step('cancel mid-generation');
  {
    await selectGetDebugFlag();
    const reviews: Proposal[] = [];
    const sub = api.onDidOpenReview((p) => reviews.push(p));
    let firstDelta: (() => void) | undefined;
    const streamed = new Promise<void>((r) => (firstDelta = r));
    const deltaSub = api.onDidStream(() => firstDelta?.());
    const started = Date.now();
    const pending = inlineEdit(mock ? `${TASK_A} SLOW` : TASK_A);
    await streamed;
    const cancelAt = Date.now();
    await vscode.commands.executeCommand('ripple.cancel');
    const result = await pending;
    const endedAt = Date.now();
    sub.dispose();
    deltaSub.dispose();
    console.log(`first delta after ${cancelAt - started} ms; run ended ${endedAt - cancelAt} ms after cancel; status ${result.status}`);
    assert.equal(result.status, 'cancelled', `expected cancelled, got ${result.status} ${result.message ?? ''}`);
    assert.equal(reviews.length, 0, 'a review opened after cancel');
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith('helpers.py'));
    assert.equal(doc?.isDirty, false, 'helpers.py buffer is dirty after cancel');
    assert.equal(doc?.getText(), original, 'helpers.py buffer changed after cancel');
    assert.equal(gitStatus(), '', 'git status not clean after cancel');
    const runId = result.runIds.at(-1)!;
    assert.equal(api.tx.getRun(runId)?.state, 'cancelled');
    assert.ok(api.tx.proposalsFor(runId).every((p) => p.state === 'discarded'), 'staged hunks not discarded');
  }

  // ---- 2. Task A: in-editor review, accept every hunk, verify, one undo.
  step('Task A: accept all hunks');
  {
    const editor = await selectGetDebugFlag();
    const reviews: Proposal[] = [];
    let reviewEditor: vscode.TextEditor | undefined;
    const sub = api.onDidOpenReview((p) => {
      reviews.push(p);
      reviewEditor = vscode.window.activeTextEditor;
      for (const h of p.hunks) {
        console.log(`hunk ${h.id}: -${JSON.stringify(h.oldLines)} +${JSON.stringify(h.newLines)}`);
        void vscode.commands.executeCommand('ripple.acceptHunk', p.id, h.id);
      }
    });
    const result = await inlineEdit(TASK_A);
    sub.dispose();
    console.log(api.logs.filter((l) => /review|tool\.response|turn\.done|replace_selection|run-/.test(l)).join('\n'));
    assert.equal(result.status, 'done', `run did not finish: ${result.message ?? ''}`);
    assert.equal(reviews.length, 1, 'expected exactly one review');
    assert.equal(reviewEditor?.document.uri.scheme, 'ripple-review', 'review was not shown in an editor');
    const p = reviews[0]!;
    console.log(`review had ${p.hunks.length} hunk(s); proposal state ${p.state}`);
    assert.ok(p.hunks.every((h) => h.status === 'applied'), 'not every hunk applied');

    const after = editor.document.getText();
    assert.notEqual(after, original);
    assert.equal(editor.document.isDirty, false, 'applied edit not saved');
    console.log(`--- get_debug_flag after edit ---\n${after.split(/\r?\n/).slice(27, 40).join('\n')}`);
    const off = debugFlag('off');
    console.log(`FLASK_DEBUG=off → ${off}; n → ${debugFlag('n')}; OFF → ${debugFlag('OFF')}; 1 → ${debugFlag('1')}`);
    assert.equal(off, 'False', 'verification command did not print False');
    // The instruction's second clause: the docstring must list the new false values.
    const docstring = debugFlagDocstring(after);
    const missing = ['off', 'n'].filter((v) => !listsValue(docstring, v));
    assert.deepEqual(
      missing,
      [],
      `Task A: the get_debug_flag docstring does not list ${missing.map((v) => `'${v}'`).join(' and ')} as false; the code changed but the docstring clause was ignored.\n--- docstring ---\n${docstring}`,
    );
    assert.notEqual(gitStatus(), '', 'expected helpers.py modified');

    // One undo restores the original file.
    await vscode.window.showTextDocument(editor.document, { preview: false });
    await vscode.commands.executeCommand('undo');
    assert.equal(editor.document.getText(), original, 'one undo did not restore the original text');
    await editor.document.save();
    assert.equal(gitStatus(), '', 'git status not clean after undo');
    assert.equal(debugFlag('off'), 'True');
  }

  // ---- 3. Partial accept (mock only: its edit always has two hunks).
  if (mock) {
    step('partial accept');
    const editor = await selectGetDebugFlag();
    const reviews: Proposal[] = [];
    const sub = api.onDidOpenReview((p) => {
      reviews.push(p);
      assert.equal(p.hunks.length, 2, 'mock edit should have two hunks');
      void vscode.commands.executeCommand('ripple.rejectHunk', p.id, p.hunks[0]!.id, 'keep the docstring as it is');
      void vscode.commands.executeCommand('ripple.acceptHunk', p.id, p.hunks[1]!.id);
    });
    const result = await inlineEdit(TASK_A);
    sub.dispose();
    assert.equal(result.status, 'done');
    const p = reviews[0]!;
    assert.deepEqual(p.hunks.map((h) => h.status), ['rejected', 'applied']);
    const report = api.tx.report(p);
    console.log(report);
    assert.match(report, /rejected by user: keep the docstring as it is/);
    const text = editor.document.getText();
    assert.ok(text.includes('"off", "n"'), 'accepted hunk missing');
    assert.ok(!text.includes('``off`` and ``n``'), 'rejected hunk was written');
    assert.ok(api.logs.some((l) => /tool\.response .*rejected by user: keep the docstring/.test(l)), 'agent not told about the rejection');
    assert.equal(debugFlag('off'), 'False');

    assert.equal(await vscode.commands.executeCommand('ripple.undoLastChange'), true);
    assert.equal(editor.document.getText(), original);
    assert.equal(gitStatus(), '', 'git status not clean after Ripple undo');
  }

  // ---- 4. Rejecting every hunk writes nothing and the agent is told.
  if (mock) {
    step('reject all');
    await selectGetDebugFlag();
    const sub = api.onDidOpenReview((p) => void vscode.commands.executeCommand('ripple.rejectAllHunks', p.id, 'not now'));
    const result = await inlineEdit(TASK_A);
    sub.dispose();
    assert.equal(result.status, 'done');
    assert.ok(api.logs.some((l) => /User denied tool call: .*rejected by user: not now/.test(l)), 'denial reason not delivered');
    assert.equal(gitStatus(), '', 'git status not clean after reject all');
  }

  // ---- 5. Task B: Agent mode unprompted multi-file edit with receipt, pytest verification, and undo.
  step('Task B: Agent mode');
  {
    const TASK_B_PROMPT =
      'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

    const reviews: Proposal[] = [];
    const sub = api.onDidOpenReview((p) => {
      reviews.push(p);
      console.log(`[Task B review] proposal ${p.id} for ${p.path} with ${p.hunks.length} hunk(s)`);
      for (const h of p.hunks) {
        void vscode.commands.executeCommand('ripple.acceptHunk', p.id, h.id);
      }
    });

    const result = await vscode.commands.executeCommand<RunResult>('ripple.agentRun', {
      instruction: TASK_B_PROMPT,
      agentPath: process.env['RIPPLE_TEST_AGENT'],
    });
    sub.dispose();

    console.log(`Task B run result: ${result?.status}${result?.message ? ` (${result.message})` : ''}`);
    assert.equal(result?.status, 'done', `Task B failed: ${result?.message ?? ''}`);

    // Verify at least 3 files touched
    const touchedFiles = reviews.map((p) => p.path);
    console.log(`Task B touched files: ${touchedFiles.join(', ')}`);
    assert.ok(touchedFiles.length >= 3, `Expected at least 3 files touched, got ${touchedFiles.length}: ${touchedFiles.join(', ')}`);
    assert.ok(touchedFiles.some((f) => f.includes('cli.py')), 'src/flask/cli.py not modified');
    assert.ok(touchedFiles.some((f) => f.includes('test_cli.py')), 'tests/test_cli.py not modified');
    assert.ok(touchedFiles.some((f) => f.includes('cli.rst')), 'docs/cli.rst not modified');

    // The receipt shown in the panel names the tests and docs, with co-change evidence.
    const receipt = api.lastReceipt();
    assert.ok(receipt, 'retrieve_context was never called, so there is no receipt');
    console.log(receipt.receipt.map((r) => `receipt: ${r.path} [${r.reason}, ~${r.tokens}] ${r.evidence}`).join('\n'));
    console.log(receipt.evicted.map((e) => `evicted: ${e.path}: ${e.reason}`).join('\n'));
    for (const wanted of ['tests/test_cli.py', 'docs/cli.rst']) {
      const row = receipt.receipt.find((r) => r.path === wanted);
      assert.ok(row, `receipt does not contain ${wanted}`);
      assert.match(row.evidence, /changed with \S+ in \d+ commits/, `${wanted} has no co-change evidence: ${row.evidence}`);
    }
    assert.ok(receipt.usedTokens <= receipt.budgetTokens, 'receipt exceeds its budget');

    // Verify all hunks were applied
    for (const p of reviews) {
      assert.ok(p.hunks.every((h) => h.status === 'applied'), `Not all hunks applied in ${p.path}`);
    }

    // Verify git status reflects the changes
    const status = gitStatus();
    console.log(`Git status after Task B apply:\n${status}`);
    assert.notEqual(status, '', 'Expected changes in working directory');

    // Verify pytest passes
    const py = process.env['RIPPLE_TEST_PYTHON'] ?? 'python';
    console.log('Running pytest tests/test_cli.py -q...');
    let pytestOut = '';
    try {
      pytestOut = execFileSync(py, ['-m', 'pytest', 'tests/test_cli.py', '-k', 'test_config_command', '-q'], {
        cwd: root(),
        env: { ...process.env, PYTHONPATH: 'src' },
        encoding: 'utf-8',
      });
    } catch (err: any) {
      console.log('pytest stdout:', err.stdout?.toString());
      console.log('pytest stderr:', err.stderr?.toString());
      throw err;
    }
    console.log(`pytest output:\n${pytestOut}`);
    assert.ok(pytestOut.includes('passed'), 'test_config_command did not pass');

    // Verify flask --help contains config
    console.log('Verifying flask --help lists config...');
    const helpOut = execFileSync(
      py,
      [
        '-c',
        'from flask.cli import FlaskGroup; from click.testing import CliRunner; from flask import Flask; r = CliRunner().invoke(FlaskGroup(create_app=lambda: Flask("app")), ["--help"]); print(r.output)',
      ],
      {
        cwd: root(),
        env: { ...process.env, PYTHONPATH: 'src' },
        encoding: 'utf-8',
      },
    );
    console.log(`flask --help output:\n${helpOut}`);
    assert.ok(helpOut.includes('config'), 'flask --help does not list config command');

    // Verify flask config prints masked JSON
    console.log('Verifying flask config output masking...');
    const configOut = execFileSync(
      py,
      [
        '-c',
        'from flask.cli import FlaskGroup; from click.testing import CliRunner; from flask import Flask; app = Flask("app"); app.config["SECRET_KEY"] = "secret123"; app.config["API_TOKEN"] = "token456"; app.config["NORMAL"] = "ok"; r = CliRunner().invoke(FlaskGroup(create_app=lambda: app), ["config"]); print(r.output)',
      ],
      {
        cwd: root(),
        env: { ...process.env, PYTHONPATH: 'src' },
        encoding: 'utf-8',
      },
    );
    console.log(`flask config output:\n${configOut}`);
    assert.ok(configOut.includes('"SECRET_KEY": "***"'), 'SECRET_KEY was not masked');
    assert.ok(configOut.includes('"API_TOKEN": "***"'), 'API_TOKEN was not masked');
    assert.ok(configOut.includes('"NORMAL": "ok"'), 'NORMAL key was altered');
    assert.ok(!configOut.includes('secret123'), 'Raw secret leaked in output');

    // Verify undoLastChange restores all files as ONE atomic undo
    console.log('Verifying atomic undo...');
    const undoOk = await vscode.commands.executeCommand('ripple.undoLastChange');
    assert.equal(undoOk, true, 'undoLastChange returned false');
    const statusAfterUndo = gitStatus();
    console.log(`Git status after undo:\n${statusAfterUndo}`);
    assert.equal(statusAfterUndo, '', 'git status not clean after undoLastChange');
  }
}
