// Standalone integration suite for Task B evaluation across fresh Flask 3.1.3 clones.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RippleApi } from '../../src/extension';
import type { RunResult } from '../../src/trueforge/runner';
import type { Proposal } from '../../src/core/transactions';

const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

function root(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'no workspace folder');
  return folder.uri.fsPath.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

function gitStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root(), encoding: 'utf-8' }).trim();
}

export async function run(): Promise<void> {
  const runIndex = process.env['RIPPLE_RUN_INDEX'] ?? '1';
  const outPath = process.env['RIPPLE_RUN_OUT'] ?? '';
  console.log(`\n========================================`);
  console.log(`=== TASK B VALIDATION RUN ${runIndex} ===`);
  console.log(`========================================\n`);

  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'ripple');
  assert.ok(ext, 'Ripple extension not found');
  const api = (await ext.activate()) as RippleApi;

  const initialStatus = gitStatus();
  console.log(`Initial git status:\n${initialStatus || '(clean)'}`);
  assert.equal(initialStatus, '', 'clone is not clean at start');

  const startTime = Date.now();
  const reviews: Proposal[] = [];
  const sub = api.onDidOpenReview((p) => {
    reviews.push(p);
    console.log(`[Task B review] proposal ${p.id} for ${p.path} with ${p.hunks.length} hunk(s)`);
    for (const h of p.hunks) {
      void vscode.commands.executeCommand('ripple.acceptHunk', p.id, h.id);
    }
  });

  console.log(`Starting agent run with prompt: "${TASK_B}"`);
  const result = await vscode.commands.executeCommand<RunResult>('ripple.agentRun', {
    instruction: TASK_B,
    agentPath: process.env['RIPPLE_TEST_AGENT'],
    approveCommands: 'tests-only',
  });
  const durationMs = Date.now() - startTime;
  sub.dispose();

  // What the run did: tool calls, model errors, retries and any fallback switch.
  const trace = api.logs.filter((l) => /\[run\]|\[fallback\]|\[command\]|Model Error|turn\.done|model\.message\.delta|\[review\]|tool\.response|\[mcp\]|budget|compact|summar/i.test(l));
  // One line per console.log: VS Code drops a single huge log message ("Output omitted").
  // The full trace also goes to a file next to the run report.
  if (outPath) writeFileSync(outPath.replace(/\.json$/, '') + '.trace.log', api.logs.join('\n'), 'utf-8');
  console.log(`--- run trace (${trace.length} lines${outPath ? `; full log: ${outPath.replace(/\.json$/, '')}.trace.log` : ''}) ---`);
  for (const l of trace) console.log(l.slice(0, 400));
  console.log('--- end trace ---');
  console.log(`Finished on model: ${result?.model}; hunks written: ${result?.hunksWritten}; fallback: ${result?.fallback ? `${result.fallback.from} -> ${result.fallback.to}` : 'none'}`);
  // Every check still runs when the fallback model finished the task, so the result is known;
  // but such a run does not count as a pass for the model under test (asserted at the end).
  const viaFallback = result?.fallback;
  if (viaFallback) console.log(`Note: ${viaFallback.from} failed (${viaFallback.reason.slice(0, 160)}); ${viaFallback.to} finished the task.`);

  console.log(`Task B completed in ${durationMs} ms with status: ${result?.status}${result?.message ? ` (${result.message})` : ''}`);
  assert.equal(result?.status, 'done', `Task B failed: ${result?.message ?? ''}`);

  // 1. Files discovered and touched
  const touchedFiles = [...new Set(reviews.map((p) => p.path))];
  console.log(`Files touched (${touchedFiles.length}): ${touchedFiles.join(', ')}`);
  assert.ok(touchedFiles.length >= 3, `Expected >= 3 files touched, got ${touchedFiles.length}: ${touchedFiles.join(', ')}`);
  assert.ok(touchedFiles.some((f) => f.includes('cli.py')), 'src/flask/cli.py was not modified');
  assert.ok(touchedFiles.some((f) => f.includes('test_cli.py')), 'tests/test_cli.py was not modified');
  assert.ok(touchedFiles.some((f) => f.includes('cli.rst')), 'docs/cli.rst was not modified');

  // 2. Receipt and evidence
  const receipt = api.lastReceipt();
  assert.ok(receipt, 'No receipt recorded from retrieve_context');
  console.log(`Receipt budget: ${receipt.budgetTokens} tokens, used: ${receipt.usedTokens} tokens`);
  for (const row of receipt.receipt) {
    console.log(`  receipt: ${row.path} [${row.reason}, ~${row.tokens} tokens] evidence: ${row.evidence}`);
  }
  for (const ev of receipt.evicted) {
    console.log(`  evicted: ${ev.path}: ${ev.reason}`);
  }
  for (const wanted of ['tests/test_cli.py', 'docs/cli.rst']) {
    const row = receipt.receipt.find((r) => r.path === wanted);
    assert.ok(row, `Receipt missing expected file: ${wanted}`);
    assert.match(row.evidence, /changed with \S+ in \d+ commits/, `${wanted} has no co-change evidence`);
  }
  assert.ok(receipt.usedTokens <= receipt.budgetTokens, 'Receipt used tokens exceeded budget');

  // 3. Git status after apply
  const statusAfterApply = gitStatus();
  console.log(`Git status after apply:\n${statusAfterApply}`);
  assert.notEqual(statusAfterApply, '', 'Expected changes in working directory');

  // 4. Pytest verification
  const py = process.env['RIPPLE_TEST_PYTHON'] ?? 'python';
  console.log(`Running pytest on ${py}...`);
  let pytestOut = '';
  try {
    pytestOut = execFileSync(py, ['-m', 'pytest', 'tests/test_cli.py', '-q'], {
      cwd: root(),
      env: { ...process.env, PYTHONPATH: 'src' },
      encoding: 'utf-8',
    });
  } catch (err: any) {
    pytestOut = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
    console.log(`pytest failed output:\n${pytestOut}`);
    throw err;
  }
  console.log(`pytest output:\n${pytestOut.trim()}`);
  assert.match(pytestOut, /\d+ passed/, 'tests/test_cli.py did not pass');
  assert.doesNotMatch(pytestOut, /failed|error/i, 'tests/test_cli.py has failures');

  // 5. Verify flask --help
  console.log('Verifying flask --help lists config command...');
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
  console.log(`flask --help snippet:\n${helpOut.slice(0, 300)}...`);
  assert.ok(helpOut.includes('config'), 'flask --help does not list config command');

  // 6. Verify masking of sensitive keys
  console.log('Verifying flask config output masking...');
  const configOut = execFileSync(
    py,
    [
      '-c',
      'from flask.cli import FlaskGroup; from click.testing import CliRunner; from flask import Flask; app = Flask("app"); app.config["SECRET_KEY"] = "secret123"; app.config["API_TOKEN"] = "token456"; app.config["DB_PASSWORD"] = "pw789"; app.config["SIGNING_KEY"] = "key000"; app.config["NORMAL"] = "ok"; r = CliRunner().invoke(FlaskGroup(create_app=lambda: app), ["config"]); print(r.output)',
    ],
    {
      cwd: root(),
      env: { ...process.env, PYTHONPATH: 'src' },
      encoding: 'utf-8',
    },
  );
  console.log(`flask config output:\n${configOut.trim()}`);
  assert.ok(configOut.includes('"SECRET_KEY": "***"'), 'SECRET_KEY was not masked');
  assert.ok(configOut.includes('"API_TOKEN": "***"'), 'API_TOKEN was not masked');
  assert.ok(configOut.includes('"DB_PASSWORD": "***"'), 'DB_PASSWORD was not masked');
  assert.ok(configOut.includes('"SIGNING_KEY": "***"'), 'SIGNING_KEY was not masked');
  assert.doesNotThrow(() => JSON.parse(configOut), 'flask config did not output valid JSON');
  assert.ok(configOut.includes('"NORMAL": "ok"'), 'NORMAL configuration was altered');
  assert.ok(!configOut.includes('secret123'), 'Raw secret leaked in output');

  // 7. Atomic undo
  console.log('Verifying atomic undo...');
  const undoOk = await vscode.commands.executeCommand('ripple.undoLastChange');
  assert.equal(undoOk, true, 'undoLastChange returned false');
  const statusAfterUndo = gitStatus();
  console.log(`Git status after undo:\n${statusAfterUndo || '(clean)'}`);
  assert.equal(statusAfterUndo, '', 'git status not clean after undo');

  // Save run report
  const report = {
    runIndex: Number(runIndex),
    model: process.env['RIPPLE_TEST_MODEL'] ?? 'gemini/gemini-3-1-flash-lite',
    finishedOn: result?.model,
    fallback: viaFallback ?? null,
    durationMs,
    status: result?.status,
    touchedFiles,
    receiptEvidence: receipt.receipt.map((r) => ({ path: r.path, reason: r.reason, tokens: r.tokens, evidence: r.evidence })),
    pytestOutput: pytestOut.trim(),
    configOutput: configOut.trim(),
    success: !viaFallback,
  };

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
  }

  // All checks passed. A pass that needed the fallback model is reported, not counted.
  assert.equal(viaFallback, undefined, `Task B passed every check, but only after falling back from ${viaFallback?.from} to ${viaFallback?.to}`);
  console.log(`\n=== RUN ${runIndex} PASSED SUCCESSFULLY ===\n`);
}
