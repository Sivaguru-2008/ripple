// Agent panel webview in the activity bar (AGENTS.md section 4 & 5).
import * as vscode from 'vscode';
import type { EvictedRow, ReceiptRow, RetrieveResult } from '../core/retrieve';

export interface PanelToolCall {
  id: string;
  name: string;
  args: string;
  status: 'running' | 'done' | 'denied' | 'error';
  resultText?: string;
}

export interface PanelReceiptData {
  task: string;
  budgetTokens: number;
  usedTokens: number;
  receipt: ReceiptRow[];
  evicted: EvictedRow[];
  evictedUnlisted: number;
}

export interface PanelStagedSummary {
  files: { path: string; hunksCount: number; detail: string }[];
  totalHunks: number;
}

export interface AgentPanelState {
  status: 'idle' | 'running' | 'done' | 'cancelled' | 'error';
  statusMessage?: string;
  sessionId?: string;
  trueforgeBaseUrl: string;
  streamedText: string;
  toolCalls: PanelToolCall[];
  receipt?: PanelReceiptData;
  staged?: PanelStagedSummary;
}

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ripple.agentView';

  private view?: vscode.WebviewView;
  private state: AgentPanelState;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onPromptSubmitted: (prompt: string) => Promise<void>,
    private readonly onCancelRequested: () => Promise<void>,
    private readonly onUndoRequested: () => Promise<void>,
    trueforgeBaseUrl: string,
  ) {
    this.state = {
      status: 'idle',
      trueforgeBaseUrl,
      streamedText: '',
      toolCalls: [],
    };
  }

  resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg: { command: string; text?: string; path?: string; url?: string }) => {
      switch (msg.command) {
        case 'submit':
          if (msg.text) await this.onPromptSubmitted(msg.text);
          break;
        case 'cancel':
          await this.onCancelRequested();
          break;
        case 'undo':
          await this.onUndoRequested();
          break;
        case 'openUrl':
          if (msg.url) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;
        case 'openFile':
          if (msg.path) {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (folder) {
              const uri = vscode.Uri.joinPath(folder.uri, msg.path);
              void vscode.workspace.openTextDocument(uri).then((doc) => vscode.window.showTextDocument(doc));
            }
          }
          break;
      }
    });

    // Send current state to webview
    this.postState();
  }

  public setStatus(status: AgentPanelState['status'], message?: string, sessionId?: string): void {
    this.state.status = status;
    this.state.statusMessage = message;
    if (sessionId) this.state.sessionId = sessionId;
    this.postState();
  }

  public resetRun(sessionId?: string): void {
    this.state.status = 'running';
    this.state.statusMessage = undefined;
    this.state.sessionId = sessionId;
    this.state.streamedText = '';
    this.state.toolCalls = [];
    this.state.receipt = undefined;
    this.state.staged = undefined;
    this.postState();
  }

  public appendStreamedDelta(text: string): void {
    this.state.streamedText += text;
    this.postState();
  }

  public recordToolCall(call: PanelToolCall): void {
    const existing = this.state.toolCalls.find((c) => c.id === call.id);
    if (existing) {
      existing.status = call.status;
      if (call.name && call.name !== '(tool)') existing.name = call.name;
      if (call.args) existing.args = call.args;
      if (call.resultText) existing.resultText = call.resultText;
    } else {
      this.state.toolCalls.push(call);
    }
    this.postState();
  }

  public setReceipt(result: RetrieveResult): void {
    this.state.receipt = {
      task: result.task,
      budgetTokens: result.budgetTokens,
      usedTokens: result.usedTokens,
      receipt: result.receipt,
      evicted: result.evicted,
      evictedUnlisted: result.evictedUnlisted,
    };
    this.postState();
  }

  public setStaged(summary: PanelStagedSummary): void {
    this.state.staged = summary;
    this.postState();
  }

  private postState(): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: 'state', state: this.state });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https:; font-src ${webview.cspSource};">
  <title>Ripple Agent</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      margin: 0;
      padding: 12px;
      box-sizing: border-box;
      line-height: 1.4;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }
    .title {
      font-weight: 600;
      font-size: 1.1em;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-badge {
      font-size: 0.8em;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 500;
      text-transform: uppercase;
    }
    .status-idle { background: var(--vscode-badge-background, #333); color: var(--vscode-badge-foreground, #ccc); }
    .status-running { background: #007acc; color: #fff; animation: pulse 1.5s infinite; }
    .status-done { background: #2ea043; color: #fff; }
    .status-cancelled { background: #8b949e; color: #fff; }
    .status-error { background: #f85149; color: #fff; }
    @keyframes pulse { 0% { opacity: 0.8; } 50% { opacity: 1; } 100% { opacity: 0.8; } }

    .session-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-size: 0.85em;
      cursor: pointer;
    }
    .session-link:hover { text-decoration: underline; }

    .prompt-box {
      margin-bottom: 14px;
    }
    textarea {
      width: 100%;
      height: 70px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #444);
      border-radius: 4px;
      padding: 8px;
      font-family: inherit;
      font-size: 0.95em;
      box-sizing: border-box;
      resize: vertical;
    }
    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 6px;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      padding: 6px 14px;
      font-size: 0.9em;
      cursor: pointer;
      font-weight: 500;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }

    .section-title {
      font-weight: 600;
      font-size: 0.85em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin: 16px 0 6px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .output-area {
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 4px;
      padding: 8px;
      font-size: 0.9em;
      max-height: 180px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      margin-bottom: 12px;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .tool-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 14px;
    }
    .tool-card {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-widget-border, #333);
      border-radius: 4px;
      padding: 6px 8px;
      font-size: 0.85em;
    }
    .tool-header {
      display: flex;
      justify-content: space-between;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .tool-args {
      color: var(--vscode-descriptionForeground);
      font-family: monospace;
      font-size: 0.85em;
      white-space: pre-wrap;
      max-height: 60px;
      overflow-y: hidden;
    }

    /* Receipt table styles */
    .receipt-container {
      background: var(--vscode-sideBar-background, #1e1e1e);
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 4px;
      padding: 8px;
      margin-bottom: 14px;
    }
    .receipt-meta {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .receipt-item {
      padding: 6px 0;
      border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a);
      font-size: 0.85em;
    }
    .receipt-item:last-child { border-bottom: none; }
    .file-path {
      font-weight: 600;
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
    }
    .file-path:hover { text-decoration: underline; }
    .badge {
      display: inline-block;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.75em;
      margin-left: 6px;
      font-weight: 600;
    }
    .badge-cochange { background: #388bfd33; color: #58a6ff; }
    .badge-pairing { background: #7ee78733; color: #56d364; }
    .badge-lexical { background: #d2992233; color: #e3b341; }
    .badge-pinned { background: #a371f733; color: #bc8cff; }
    .badge-import { background: #f0883e33; color: #ffa657; }
    .evidence {
      color: var(--vscode-descriptionForeground);
      font-size: 0.8em;
      margin-top: 2px;
    }
    .evicted-header {
      font-weight: 600;
      margin-top: 8px;
      font-size: 0.85em;
      color: var(--vscode-errorForeground, #f85149);
    }
    .evicted-item {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      padding: 2px 0;
    }

    .staged-box {
      background: #1e3a29;
      border: 1px solid #2ea043;
      border-radius: 4px;
      padding: 8px;
      font-size: 0.85em;
      margin-bottom: 12px;
    }
    .staged-title {
      font-weight: 600;
      color: #7ee787;
      margin-bottom: 4px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">
      Ripple
      <span id="status-badge" class="status-badge status-idle">IDLE</span>
    </div>
    <div id="session-container"></div>
  </div>

  <div class="prompt-box">
    <textarea id="prompt-input" placeholder="Ask Ripple to code, test, or refactor (@file, @symbol)..."></textarea>
    <div class="actions">
      <button id="send-btn">Run Agent</button>
      <button id="cancel-btn" class="secondary" disabled>Cancel</button>
      <button id="undo-btn" class="secondary" title="Restore files to text before last run">Undo Edit</button>
    </div>
  </div>

  <div id="staged-container"></div>

  <div class="section-title">Context Receipt</div>
  <div id="receipt-container" class="receipt-container">
    <div class="receipt-meta">No context retrieved yet. Call retrieve_context or prompt the agent.</div>
  </div>

  <div class="section-title">Tool Calls</div>
  <div id="tools-container" class="tool-list">
    <div style="font-size: 0.85em; color: var(--vscode-descriptionForeground);">No active tool calls.</div>
  </div>

  <div class="section-title">Agent Output</div>
  <div id="output-area" class="output-area">Waiting for prompt...</div>

  <script>
    const vscode = acquireVsCodeApi();
    const promptInput = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('send-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const undoBtn = document.getElementById('undo-btn');
    const statusBadge = document.getElementById('status-badge');
    const sessionContainer = document.getElementById('session-container');
    const outputArea = document.getElementById('output-area');
    const toolsContainer = document.getElementById('tools-container');
    const receiptContainer = document.getElementById('receipt-container');
    const stagedContainer = document.getElementById('staged-container');

    sendBtn.addEventListener('click', () => {
      const text = promptInput.value.trim();
      if (!text) return;
      vscode.postMessage({ command: 'submit', text });
    });

    cancelBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });

    undoBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'undo' });
    });

    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendBtn.click();
      }
    });

    function escapeHtml(s) {
      return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    window.addEventListener('message', (event) => {
      const { type, state } = event.data;
      if (type === 'state') {
        renderState(state);
      }
    });

    function renderState(state) {
      statusBadge.textContent = state.status.toUpperCase();
      statusBadge.className = 'status-badge status-' + state.status;

      const isRunning = state.status === 'running';
      sendBtn.disabled = isRunning;
      cancelBtn.disabled = !isRunning;

      if (state.sessionId) {
        const url = state.trueforgeBaseUrl + '/sessions/' + state.sessionId;
        sessionContainer.innerHTML = '<a class="session-link" data-url="' + escapeHtml(url) + '">Session in TrueForge ↗</a>';
      } else {
        sessionContainer.innerHTML = '';
      }

      outputArea.textContent = state.streamedText || (isRunning ? 'Streaming...' : 'Waiting for prompt...');

      // Render tool calls
      if (state.toolCalls && state.toolCalls.length > 0) {
        toolsContainer.innerHTML = state.toolCalls.map(c => \`
          <div class="tool-card">
            <div class="tool-header">
              <span>\${escapeHtml(c.name)}</span>
              <span style="font-size: 0.8em; color: \${c.status === 'done' ? '#56d364' : c.status === 'error' ? '#f85149' : '#e3b341'}">\${c.status.toUpperCase()}</span>
            </div>
            <div class="tool-args">\${escapeHtml(c.args.length > 240 ? c.args.slice(0, 240) + '…' : c.args)}</div>
            \${c.resultText ? '<div class="tool-args">→ ' + escapeHtml(c.resultText) + '</div>' : ''}
          </div>
        \`).join('');
      } else {
        toolsContainer.innerHTML = '<div style="font-size: 0.85em; color: var(--vscode-descriptionForeground);">No active tool calls.</div>';
      }

      // Render Receipt
      if (state.receipt) {
        const r = state.receipt;
        const remainingTokens = Math.max(0, r.budgetTokens - r.usedTokens);
        let html = '<div class="receipt-meta"><strong>Budget:</strong> ' + r.budgetTokens + ' tokens | <strong>Used:</strong> ' + r.usedTokens + ' tokens | <strong>Remaining:</strong> ' + remainingTokens + ' tokens (' + r.receipt.length + ' files packed)</div>';
        for (const row of r.receipt) {
          const badgeClass = 'badge badge-' + (row.reason === 'co-change' ? 'cochange' : row.reason);
          html += \`
            <div class="receipt-item">
              <div>
                <span class="file-path" data-path="\${escapeHtml(row.path)}">\${escapeHtml(row.path)}</span>
                <span class="\${badgeClass}">\${escapeHtml(row.reason)}</span>
                <span style="color: var(--vscode-descriptionForeground); font-size: 0.8em; float: right;">~\${row.tokens} tok</span>
              </div>
              <div class="evidence">\${escapeHtml(row.evidence)}</div>
            </div>
          \`;
        }
        if (r.evicted && r.evicted.length > 0) {
          html += '<div class="evicted-header">Evicted candidates:</div>';
          for (const ev of r.evicted) {
            html += '<div class="evicted-item">• <strong>' + escapeHtml(ev.path) + '</strong>: ' + escapeHtml(ev.reason) + '</div>';
          }
          if (r.evictedUnlisted > 0) {
            html += '<div class="evicted-item">• and ' + r.evictedUnlisted + ' lower-ranked file(s)</div>';
          }
        }
        receiptContainer.innerHTML = html;
      }

      // Render Staged Multi-file Summary
      if (state.staged && state.staged.totalHunks > 0) {
        let html = '<div class="staged-box">';
        html += '<div class="staged-title">Changes by file (' + state.staged.totalHunks + ' hunks in ' + state.staged.files.length + ' files)</div>';
        for (const f of state.staged.files) {
          html += '<div>• <span class="file-path" data-path="' + escapeHtml(f.path) + '">' + escapeHtml(f.path) + '</span>: ' + escapeHtml(f.detail) + '</div>';
        }
        html += '</div>';
        stagedContainer.innerHTML = html;
      } else {
        stagedContainer.innerHTML = '';
      }
    }

    document.addEventListener('click', (e) => {
      const urlEl = e.target.closest('[data-url]');
      if (urlEl) {
        const u = urlEl.getAttribute('data-url');
        if (u) openUrl(u);
        return;
      }
      const pathEl = e.target.closest('[data-path]');
      if (pathEl) {
        const p = pathEl.getAttribute('data-path');
        if (p) openFile(p);
        return;
      }
    });

    function openFile(p) {
      vscode.postMessage({ command: 'openFile', path: p });
    }

    function openUrl(u) {
      vscode.postMessage({ command: 'openUrl', url: u });
    }
  </script>
</body>
</html>`;
  }
}
