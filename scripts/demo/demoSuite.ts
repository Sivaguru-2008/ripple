// Demo driver for the Forge-a-thon video. Runs inside a real VS Code Extension Development Host
// on a fresh flask 3.1.3 clone (started by scripts/demo/record-demo.mjs) and performs Tasks A, B
// and C in order, at a pace a viewer can follow, with the on-screen verification the brief asks
// for. The models, edits, tests and results are real; the clicks and keystrokes are scripted,
// and the video says so.
//
// It writes a timeline (captions, and which stretches are model waiting time to be sped up) to
// RIPPLE_DEMO_TIMELINE for the editing step.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RippleApi } from '../../src/extension';
import type { RunResult } from '../../src/trueforge/runner';
import type { Proposal } from '../../src/core/transactions';

const TASK_A =
  "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
const HELPERS = 'src/flask/helpers.py';

type Event =
  | { t: number; kind: 'caption'; text: string }
  | { t: number; kind: 'fast'; on: boolean }
  | { t: number; kind: 'mark'; name: string };

const timeline: Event[] = [];
const timelinePath = process.env['RIPPLE_DEMO_TIMELINE'] ?? path.join(os.tmpdir(), 'ripple-demo-timeline.json');
const save = (): void => writeFileSync(timelinePath, JSON.stringify(timeline, null, 1));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let fastOn = false;
function caption(text: string): void {
  timeline.push({ t: Date.now(), kind: 'caption', text });
  save();
}
function fast(on: boolean): void {
  if (on === fastOn) return;
  fastOn = on;
  timeline.push({ t: Date.now(), kind: 'fast', on });
  save();
}
function mark(name: string): void {
  timeline.push({ t: Date.now(), kind: 'mark', name });
  save();
}
/** Shows a caption and gives the viewer time to read it (about 14 characters a second). */
async function say(text: string, minMs = 2500): Promise<void> {
  caption(text);
  await sleep(Math.max(minMs, text.length * 70));
}

function root(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder');
  return folder.uri.fsPath.replace(/^[a-z]:/, (d) => d.toUpperCase());
}

function gitStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root(), encoding: 'utf-8' }).trim();
}

let terminal: vscode.Terminal | undefined;
/** Runs a command in a visible terminal and leaves time to read its output. */
async function shell(command: string, holdMs: number): Promise<void> {
  if (!terminal) {
    const py = process.env['RIPPLE_TEST_PYTHON'];
    const dir = py && path.isAbsolute(py) ? path.dirname(py) : undefined;
    terminal = vscode.window.createTerminal({
      name: 'verify',
      cwd: root(),
      env: { PYTHONPATH: 'src', ...(dir ? { PATH: `${dir};${path.join(dir, 'Scripts')};${process.env['PATH'] ?? ''}` } : {}) },
    });
    terminal.show(true);
    await sleep(2500);
  }
  terminal.show(true);
  terminal.sendText(command, true);
  await sleep(holdMs);
}

async function openHelpersAndSelect(): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.Uri.file(root()), HELPERS));
  const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
  const lines = doc.getText().split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('def get_debug_flag'));
  const end = lines.findIndex((l, i) => i > start && l.trimStart().startsWith('return bool('));
  editor.selection = new vscode.Selection(start, 0, end, lines[end]?.length ?? 0);
  editor.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenter);
  return editor;
}

/** Accepts (or rejects) every hunk of a review one by one, slowly enough to see each. */
async function decideHunks(p: Proposal, accept: boolean, gapMs: number): Promise<void> {
  for (const h of p.hunks) {
    await vscode.commands.executeCommand(accept ? 'ripple.acceptHunk' : 'ripple.rejectHunk', p.id, h.id);
    await sleep(gapMs);
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'ripple');
  if (!ext) throw new Error('Ripple extension not found');
  const api = (await ext.activate()) as RippleApi;
  const demoDir = path.join(os.tmpdir(), 'ripple-demo');
  mkdirSync(demoDir, { recursive: true });
  const demoApp = path.join(demoDir, 'demo_app.py');
  writeFileSync(
    demoApp,
    'from flask import Flask\n\napp = Flask(__name__)\napp.config.update(\n    SECRET_KEY="s3cr3t",\n    DB_PASSWORD="hunter2",\n    API_TOKEN="tok-123",\n    SIGNING_KEY="k-456",\n    GREETING="hello",\n)\n',
  );
  const inlineAgent = process.env['RIPPLE_TEST_INLINE_AGENT'];
  const agent = process.env['RIPPLE_TEST_AGENT'];
  if (gitStatus() !== '') throw new Error('the clone is not clean at the start');

  // ---- Layout: Ripple's panel on the left, the editor in the middle.
  await vscode.commands.executeCommand('workbench.view.extension.ripple-sidebar');
  await openHelpersAndSelect();
  await sleep(1500);
  mark('start');

  // ===================== Task A: inline edit =====================
  mark('taskA');
  await say('Task A, inline edit. get_debug_flag is selected in src/flask/helpers.py; the shortcut Ctrl+; asks Ripple to change it.', 4000);
  await say(`Instruction: "${TASK_A}"`, 5000);
  let reviewA: Proposal | undefined;
  const subA = api.onDidOpenReview((p) => (reviewA = p));
  const runA = vscode.commands.executeCommand<RunResult>('ripple.inlineEdit', { instruction: TASK_A, agentPath: inlineAgent });
  caption('The model runs on TrueForge; its tokens stream in as they arrive.');
  for (let k = 0; k < 600 && !reviewA; k++) await sleep(100);
  subA.dispose();
  if (!reviewA) throw new Error('Task A: no review opened');
  mark('A1-review');
  await say(`The proposed change opens as a diff in the editor: ${reviewA.hunks.length} hunks, each with its own Accept and Reject.`, 4500);
  caption('Accepting hunk by hunk. Nothing is written until a hunk is accepted.');
  await decideHunks(reviewA, true, 1800);
  const resultA = await runA;
  if (resultA?.status !== 'done') throw new Error(`Task A failed: ${resultA?.message ?? resultA?.status}`);
  const edited = vscode.window.activeTextEditor;
  if (edited) edited.selection = new vscode.Selection(edited.selection.start, edited.selection.start);
  await sleep(1000);
  mark('A-verify');
  await say('Verify: with FLASK_DEBUG=off, get_debug_flag() must print False.', 2500);
  await shell(`$env:FLASK_DEBUG='off'; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`, 7000);
  mark('B2-undo');
  await say('One undo restores the file; git status is clean again.', 2500);
  await vscode.commands.executeCommand('ripple.undoLastChange');
  await shell('Remove-Item Env:FLASK_DEBUG; git status', 4000);

  // ===================== Task B: agent mode =====================
  mark('taskB');
  await vscode.commands.executeCommand('workbench.view.extension.ripple-sidebar');
  await say('Task B, agent mode. The request names no files; the agent has to find them.', 3500);

  // Streaming and cancel first, on the same request.
  await say('First, cancel: start the request, then stop it mid-run.', 2500);
  const cancelRun = vscode.commands.executeCommand<RunResult>('ripple.agentRun', { instruction: TASK_B, agentPath: agent, approveCommands: 'tests-only' });
  const receiptBefore = api.lastReceipt();
  for (let k = 0; k < 600 && api.lastReceipt() === receiptBefore; k++) await sleep(100);
  await sleep(2500);
  mark('A3-cancel');
  caption('Cancel. The run stops at once and anything staged is discarded.');
  await vscode.commands.executeCommand('ripple.cancel');
  const cancelled = await cancelRun;
  await sleep(1500);
  await shell('git status', 3500);
  if (cancelled?.status !== 'cancelled') caption(`(the run ended ${cancelled?.status} before the cancel)`);

  // The real run.
  await vscode.commands.executeCommand('workbench.view.extension.ripple-sidebar');
  await say('Now the full run. Commands the agent asks to run are approved automatically in this recording.', 4000);
  const reviewsB: Proposal[] = [];
  const queue: Proposal[] = [];
  const subB = api.onDidOpenReview((p) => {
    reviewsB.push(p);
    queue.push(p);
  });
  let doneB = false;
  const runB = vscode.commands
    .executeCommand<RunResult>('ripple.agentRun', { instruction: TASK_B, agentPath: agent, approveCommands: 'tests-only' })
    .then((r) => {
      doneB = true;
      return r;
    });
  caption('Ripple retrieves context: ranked by git co-change, test and doc pairing, and imports, inside a token budget.');
  fast(true);
  const receiptAtStart = api.lastReceipt();
  let shownReceipt = false;
  let logsSeen = api.logs.length;
  while (!doneB || queue.length) {
    if (!shownReceipt && api.lastReceipt() !== receiptAtStart) {
      shownReceipt = true;
      fast(false);
      mark('B1-receipt');
      await say('The receipt in the panel shows each file chosen, why (co-change commits, pairing), its tokens, and what was left out.', 6000);
      fast(true);
    }
    const compaction = api.logs.slice(logsSeen).find((l) => l.includes('[compaction] TrueForge is compacting'));
    logsSeen = api.logs.length;
    if (compaction) {
      fast(false);
      mark('B4-compaction');
      await say('TrueForge compacts the thread: older steps become a summary, and Ripple tells the agent what is already done.', 4500);
      fast(true);
    }
    const p = queue.shift();
    if (p) {
      fast(false);
      caption(`TrueForge's approval pause opens the review: ${p.path}, ${p.hunks.length} hunk(s).`);
      await sleep(2200);
      await decideHunks(p, true, 900);
      fast(true);
    }
    await sleep(200);
  }
  subB.dispose();
  fast(false);
  const resultB = await runB;
  const files = [...new Set(reviewsB.map((p) => p.path))];
  mark('A2-files');
  await say(`Done: the agent changed ${files.length} files it found itself: ${files.join(', ')}.`, 4000);

  const sessionId = [...api.logs].reverse().find((l) => l.startsWith('[trueforge] session '))?.split(' ')[2];
  if (sessionId) {
    const url = `${process.env['RIPPLE_TRUEFORGE_URL'] ?? 'http://localhost:8790'}/sessions/${sessionId}`;
    mark('B4-session');
    // VS Code's built-in Simple Browser, inside the recorded window. Never the system browser:
    // that would put whatever else is open there on screen.
    try {
      await vscode.commands.executeCommand('simpleBrowser.api.open', vscode.Uri.parse(url), { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
      caption("The same run in TrueForge, inside VS Code: the request, the agent's tool calls, and its answer.");
      await sleep(8000);
    } catch (err) {
      caption('(the TrueForge session view could not be opened inside VS Code)');
      console.log(`simpleBrowser.api.open failed: ${String(err)}`);
      await sleep(1500);
    }
  }
  mark('B-verify');
  await say('Verify: the CLI tests pass, including the new one.', 2500);
  await shell('python -m pytest tests/test_cli.py -q', 7000);
  await say('The new command, run against a small Flask app with secrets in its config:', 3000);
  await shell(`python -m flask --app "${demoApp}" config`, 5000);
  await shell(`python -m flask --app "${demoApp}" --help`, 5000);
  await shell('git diff --stat', 4000);
  await say('One undo reverts all three files together.', 2500);
  await vscode.commands.executeCommand('ripple.undoLastChange');
  await shell('git status', 3500);
  if (resultB?.status !== 'done') caption(`(Task B ended ${resultB?.status}: ${resultB?.message ?? ''})`);

  // ===================== Task C: resilience =====================
  mark('taskC');
  await say('Task C, resilience. Make Gemini unreachable: stop the model endpoint TrueForge uses for it.', 4000);
  await shell('Stop-Process -Id (Get-NetTCPConnection -State Listen -LocalPort 8794).OwningProcess -Force; "Gemini endpoint stopped"', 3500);
  await say('Repeat Task A.', 1500);
  await openHelpersAndSelect();
  let reviewC: Proposal | undefined;
  const subC = api.onDidOpenReview((p) => (reviewC = p));
  const runC = vscode.commands.executeCommand<RunResult>('ripple.inlineEdit', { instruction: TASK_A, agentPath: inlineAgent });
  caption('Gemini cannot be reached. Ripple retries once, then the second configured model takes over, with no user action.');
  for (let k = 0; k < 1200 && !reviewC; k++) await sleep(100);
  subC.dispose();
  if (!reviewC) throw new Error('Task C: no review opened');
  mark('B3-fallback');
  await say('The local fallback model proposed the edit. The editor stayed responsive throughout.', 3500);
  await say('While the review is open, nothing is on disk: git status is clean.', 2500);
  await shell('git status', 3500);
  caption('Reject: the workspace stays unchanged.');
  await vscode.commands.executeCommand('ripple.rejectAllHunks', reviewC.id, 'demo: keep the workspace unchanged');
  const resultC = await runC;
  await sleep(2500);
  await shell('git status', 3500);
  if (!resultC?.fallback) caption('(the fallback model was not needed)');
  mark('end');
  await sleep(1500);

  writeFileSync(
    path.join(path.dirname(timelinePath), 'demo-results.json'),
    JSON.stringify({ taskA: resultA?.status, cancel: cancelled?.status, taskB: { status: resultB?.status, files, message: resultB?.message }, taskC: { status: resultC?.status, fallback: resultC?.fallback }, statusAtEnd: gitStatus() }, null, 2),
  );
  save();
}
