// Runs in a real VS Code Extension Development Host on a fresh flask 3.1.3 clone, without
// any model turn: drives the transaction manager directly to check that a new file proposed
// by propose_write is reviewed in the editor, created in the same edit as other files,
// removed by one undo, and removed again when a run fails after it was written.
//   RIPPLE_TEST_SUITE=test/integration/newFileSuite.ts RIPPLE_TEST_MODEL=ripple-mock/mock-1 npm run test:vscode
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RippleApi } from '../../src/extension';
import type { Proposal } from '../../src/core/transactions';

const NEW_TEST = 'tests/test_ripple_new.py';
const NEW_TEXT = 'def test_ripple_new():\n    assert 1 + 1 == 2\n';

function root(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'no workspace folder');
  return folder.uri.fsPath.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

function gitStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root(), encoding: 'utf-8' }).trim();
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'ripple');
  assert.ok(ext, 'Ripple extension not found');
  const api = (await ext.activate()) as RippleApi;
  assert.equal(gitStatus(), '', 'clone is not clean at start');

  const reviews: { p: Proposal; scheme: string | undefined; text: string | undefined }[] = [];
  const sub = api.onDidOpenReview((p) => {
    const editor = vscode.window.activeTextEditor;
    reviews.push({ p, scheme: editor?.document.uri.scheme, text: editor?.document.getText() });
    for (const h of p.hunks) void vscode.commands.executeCommand('ripple.acceptHunk', p.id, h.id);
  });
  const stage = async (token: string): Promise<void> => {
    const created = await api.tx.execute(token, 'propose_write', { path: NEW_TEST, edits: [{ old_text: '', new_text: NEW_TEXT }] });
    console.log(created.text);
    assert.equal(created.isError, false, created.text);
    const edited = await api.tx.execute(token, 'propose_write', {
      path: 'docs/cli.rst',
      edits: [{ old_text: 'Open a Shell\n------------', new_text: 'Open a Shell\n------------\n\nAdded by the new-file test.' }],
    });
    assert.equal(edited.isError, false, edited.text);
  };

  console.log('\n==== new file: review, one edit with another file, one undo ====');
  {
    const r = api.tx.beginRun(undefined, { deferred: true });
    await stage(r.token);
    const first = reviews[0]!;
    assert.equal(first.p.creates, true);
    assert.equal(first.scheme, 'ripple-review', 'the new file was not shown in a review editor');
    assert.ok(first.text?.includes('def test_ripple_new():'), 'the review does not show the new file text');
    assert.equal(existsSync(path.join(root(), NEW_TEST)), false, 'the file exists before the run committed');
    assert.equal(gitStatus(), '', 'something was written before commit');

    const commit = await api.tx.commit(r.id);
    console.log(`commit: ${JSON.stringify(commit)}`);
    assert.deepEqual([commit.ok, commit.files], [true, [NEW_TEST, 'docs/cli.rst']]);
    api.tx.endRun(r.id, 'finished');
    assert.equal(readFileSync(path.join(root(), NEW_TEST), 'utf-8').replace(/\r\n/g, '\n'), NEW_TEXT);
    const status = gitStatus();
    console.log(`git status after commit:\n${status}`);
    assert.match(status, /\?\? tests\/test_ripple_new\.py/);
    assert.match(status, /M docs\/cli\.rst/);

    assert.equal(await vscode.commands.executeCommand('ripple.undoLastChange'), true);
    assert.equal(existsSync(path.join(root(), NEW_TEST)), false, 'undo did not remove the created file');
    assert.equal(gitStatus(), '', 'git status not clean after one undo');
  }

  console.log('\n==== new file: a run that fails after writing takes the file back ====');
  {
    const r = api.tx.beginRun(undefined, { deferred: true });
    await stage(r.token);
    assert.equal((await api.tx.commit(r.id)).ok, true);
    assert.equal(existsSync(path.join(root(), NEW_TEST)), true);
    api.tx.endRun(r.id, 'failed');
    const restored = await api.tx.rollback(r.id);
    console.log(`rolled back: ${restored.join(', ')}`);
    assert.equal(existsSync(path.join(root(), NEW_TEST)), false, 'rollback did not remove the created file');
    assert.equal(gitStatus(), '', 'git status not clean after rollback');
  }

  console.log('\n==== new file: cancel before commit leaves nothing ====');
  {
    const r = api.tx.beginRun(undefined, { deferred: true });
    await stage(r.token);
    api.tx.endRun(r.id, 'cancelled');
    await api.tx.rollback(r.id);
    assert.equal(existsSync(path.join(root(), NEW_TEST)), false);
    assert.equal(gitStatus(), '');
    assert.ok(vscode.workspace.textDocuments.every((d) => !d.isDirty), 'a buffer is dirty');
  }
  sub.dispose();
}
