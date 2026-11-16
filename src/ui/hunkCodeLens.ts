// Copyright 2023 Continue Dev, Inc.
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software distributed under the
// License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
// either express or implied. See the License for the specific language governing permissions
// and limitations under the License.
//
// Source: https://github.com/continuedev/continue
//   extensions/vscode/src/lang-server/codeLens/providers/VerticalPerLineCodeLensProvider.ts
//   at commit 5522c6f44ca0ac3528b37244818fbfa39b5af470
// MODIFIED for Ripple: blocks carry a TransactionManager proposal id, hunk id and decision;
// commands are ripple.acceptHunk / ripple.rejectHunk; decided hunks show their status
// instead of buttons; a file-level "Accept all / Reject all" lens was added. No dependency
// on Continue's diff manager.
import * as vscode from 'vscode';

/** One hunk as laid out in the review document. */
export interface ReviewBlock {
  proposalId: string;
  hunkId: string;
  /** First line of the hunk in the review document (0-based). */
  start: number;
  numRed: number;
  numGreen: number;
  /** Empty while undecided; otherwise e.g. "accepted" or "rejected by user: <reason>". */
  decision: string;
}

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private _eventEmitter: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();

  onDidChangeCodeLenses: vscode.Event<void> = this._eventEmitter.event;

  public refresh(): void {
    this._eventEmitter.fire();
  }

  constructor(private readonly editorToBlocks: Map<string, ReviewBlock[]>) {}

  public provideCodeLenses(document: vscode.TextDocument, _: vscode.CancellationToken): vscode.CodeLens[] {
    const uri = document.uri.toString();
    const blocks = this.editorToBlocks.get(uri);

    if (!blocks || blocks.length === 0) {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];
    const undecided = blocks.filter((b) => b.decision === '').length;
    const top = new vscode.Range(0, 0, 0, 0);
    const proposalId = blocks[0]?.proposalId ?? '';
    codeLenses.push(
      new vscode.CodeLens(top, {
        title: `Ripple review: ${blocks.length} hunk(s), ${undecided} undecided`,
        command: '',
      }),
    );
    if (undecided > 0) {
      codeLenses.push(
        new vscode.CodeLens(top, { title: 'Accept all', command: 'ripple.acceptAllHunks', arguments: [proposalId] }),
        new vscode.CodeLens(top, { title: 'Reject all', command: 'ripple.rejectAllHunks', arguments: [proposalId] }),
      );
    }

    for (const block of blocks) {
      const start = new vscode.Position(block.start, 0);
      const range = new vscode.Range(start, start.translate(block.numGreen + block.numRed));

      if (block.decision !== '') {
        codeLenses.push(new vscode.CodeLens(range, { title: `Hunk ${block.hunkId}: ${block.decision}`, command: '' }));
        continue;
      }
      codeLenses.push(
        new vscode.CodeLens(range, {
          title: `Accept`,
          command: 'ripple.acceptHunk',
          arguments: [block.proposalId, block.hunkId],
        }),
        new vscode.CodeLens(range, {
          title: `Reject`,
          command: 'ripple.rejectHunk',
          arguments: [block.proposalId, block.hunkId],
        }),
      );
    }

    return codeLenses;
  }
}
