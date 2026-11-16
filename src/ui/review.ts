// Per-hunk review of a staged proposal. The real file is never touched here: hunks are shown
// in a read-only review document (removed lines red, added lines green, Accept / Reject per
// hunk) and decisions go to the TransactionManager, which applies accepted hunks later as
// one WorkspaceEdit.
import * as vscode from 'vscode';
import type { Proposal, TransactionManager } from '../core/transactions';
import { splitLines } from '../core/diff';
import { AddedLineDecorationManager, RemovedLineDecorationManager } from './decorations';
import { HunkCodeLensProvider, type ReviewBlock } from './hunkCodeLens';

export const REVIEW_SCHEME = 'ripple-review';

interface OpenReview {
  proposal: Proposal;
  uri: vscode.Uri;
  blocks: ReviewBlock[];
  added?: AddedLineDecorationManager;
  removed?: RemovedLineDecorationManager;
  done: () => void;
}

export class ReviewController implements vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly blocksByUri = new Map<string, ReviewBlock[]>();
  private readonly reviews = new Map<string, OpenReview>();
  private readonly codeLens = new HunkCodeLensProvider(this.blocksByUri);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly openedEmitter = new vscode.EventEmitter<Proposal>();
  /** Fires when a review opens (used by the integration test and the log). */
  readonly onDidOpen = this.openedEmitter.event;

  constructor(
    private readonly tx: TransactionManager,
    private readonly log: (line: string) => void,
  ) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, {
        provideTextDocumentContent: (uri) => this.contents.get(uri.toString()) ?? '',
      }),
      vscode.languages.registerCodeLensProvider({ scheme: REVIEW_SCHEME }, this.codeLens),
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.closed) {
          if (!(tab.input instanceof vscode.TabInputText)) continue;
          const uri = tab.input.uri.toString();
          for (const r of this.reviews.values()) if (r.uri.toString() === uri) this.finish(r, false);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        // Decorations belong to an editor; re-apply when the review tab is shown again.
        for (const r of this.reviews.values()) {
          const ed = editors.find((x) => x.document.uri.toString() === r.uri.toString());
          if (ed) {
            r.added?.applyToNewEditor(ed);
            r.removed?.applyToNewEditor(ed);
          }
        }
      }),
      this.openedEmitter,
    );
  }

  /** Opens the review; resolves when every hunk is decided, the tab is closed or the run ends. */
  async show(p: Proposal, sourceUri: vscode.Uri): Promise<void> {
    const base = splitLines(p.baseText);
    const out: string[] = [];
    const blocks: ReviewBlock[] = [];
    const red: { at: number; lines: string[] }[] = [];
    const green: { at: number; count: number }[] = [];
    let cursor = 0;
    for (const h of p.hunks) {
      out.push(...base.slice(cursor, h.baseStart));
      const start = out.length;
      if (h.oldLines.length) red.push({ at: out.length, lines: h.oldLines });
      out.push(...h.oldLines);
      if (h.newLines.length) green.push({ at: out.length, count: h.newLines.length });
      out.push(...h.newLines);
      blocks.push({ proposalId: p.id, hunkId: h.id, start, numRed: h.oldLines.length, numGreen: h.newLines.length, decision: '' });
      cursor = h.baseEnd;
    }
    out.push(...base.slice(cursor));

    const uri = vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${p.path} (Ripple review ${p.id})`, query: p.id });
    this.contents.set(uri.toString(), out.join('\n'));
    this.blocksByUri.set(uri.toString(), blocks);

    return new Promise<void>((resolve) => {
      const review: OpenReview = { proposal: p, uri, blocks, done: resolve };
      this.reviews.set(p.id, review);
      void (async () => {
        try {
          let doc = await vscode.workspace.openTextDocument(uri);
          const source = vscode.workspace.textDocuments.find((d) => d.uri.toString() === sourceUri.toString());
          if (source) doc = await vscode.languages.setTextDocumentLanguage(doc, source.languageId);
          const column = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === sourceUri.toString())?.viewColumn;
          const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: column ?? vscode.ViewColumn.Active });
          review.added = new AddedLineDecorationManager(editor);
          review.removed = new RemovedLineDecorationManager(editor);
          for (const g of green) review.added.addLines(g.at, g.count);
          for (const r of red) review.removed.addLines(r.at, r.lines);
          const first = blocks[0]?.start ?? 0;
          editor.revealRange(new vscode.Range(first, 0, first, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          this.codeLens.refresh();
          this.log(`[review] ${p.id} opened: ${p.path}, ${p.hunks.length} hunk(s) [${p.hunks.map((h) => h.id).join(', ')}]`);
          this.openedEmitter.fire(p);
        } catch (err) {
          this.log(`[review] could not open review for ${p.id}: ${String(err)}`);
          this.finish(review, false);
        }
      })();
    });
  }

  /** Records a decision from the CodeLens (or a test) and closes the review when complete. */
  decide(proposalId: string, hunkId: string, accept: boolean, reason?: string): void {
    const review = this.reviews.get(proposalId);
    if (!review) return;
    this.tx.decide(proposalId, hunkId, accept, reason);
    const hunk = review.proposal.hunks.find((h) => h.id === hunkId);
    const block = review.blocks.find((b) => b.hunkId === hunkId);
    if (hunk && block && hunk.status !== 'pending') {
      block.decision = hunk.status === 'accepted' ? 'accepted' : `rejected by user: ${hunk.reason ?? ''}`;
      this.log(`[review] ${proposalId} hunk ${hunkId}: ${block.decision}`);
    }
    this.codeLens.refresh();
    if (review.proposal.hunks.every((h) => h.status !== 'pending')) this.finish(review, true);
  }

  pending(proposalId: string): string[] {
    return this.reviews.get(proposalId)?.proposal.hunks.filter((h) => h.status === 'pending').map((h) => h.id) ?? [];
  }

  /** Closes every review of a run (cancel or failure). */
  closeRun(runId: string): void {
    for (const r of [...this.reviews.values()]) if (r.proposal.runId === runId) this.finish(r, true);
  }

  private finish(review: OpenReview, closeTab: boolean): void {
    if (!this.reviews.has(review.proposal.id)) return;
    this.reviews.delete(review.proposal.id);
    review.added?.clear();
    review.removed?.clear();
    this.blocksByUri.delete(review.uri.toString());
    this.contents.delete(review.uri.toString());
    this.codeLens.refresh();
    if (closeTab) {
      const tabs = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === review.uri.toString());
      if (tabs.length) void vscode.window.tabGroups.close(tabs);
    }
    this.log(`[review] ${review.proposal.id} closed`);
    review.done();
  }

  dispose(): void {
    for (const r of [...this.reviews.values()]) this.finish(r, true);
    for (const d of this.disposables) d.dispose();
  }
}
