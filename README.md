# Ripple

> **Editor-native coding agent powered by TrueForge**  
> *Round 1 Submission for TrueFoundry Forge-a-thon (Techfest IIT Bombay 2026–27)*

![TrueForge Version](https://img.shields.io/badge/TrueForge-0.185.1-0284c7?style=flat-square)
![Tests](https://img.shields.io/badge/Tests-168%2F168%20passing-10b981?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-Strict%205.9.3-3178c6?style=flat-square)
![License](https://img.shields.io/badge/License-MIT%20%2F%20Apache--2.0-blue?style=flat-square)
![Model Cost](https://img.shields.io/badge/Model%20Spend-%240.00%20(Free%20Tier)-teal?style=flat-square)

---

## 1. What is Ripple?

Most AI coding agents write directly to disk, pull entire repositories blindly into model contexts, or break down completely when an API rate limit or outage occurs.

**Ripple** is a Visual Studio Code extension that makes autonomous agent workflows **controllable, observable, and resilient**:

* **Trust the workflow. Not just the model.**

### Three Architectural Pillars

1. **Fenced Edit Transactions (Diff Safety & Undo)**
   * **Zero direct writes to disk.** Every modification is staged in an in-memory buffer.
   * **Per-hunk review in editor diff tabs.** The developer inspects and accepts or rejects each change independently.
   * **Atomic WorkspaceEdit & one-step undo.** Multi-file modifications apply as a single atomic batch that reverts completely with one standard Undo action (`Ctrl+Z`).
   * **Idempotent hunk hashing.** Hunk ID = `SHA256(base_text, range, new_text)`. Retries and stale proposals fail cleanly without corrupting the workspace.

2. **Ripple Retrieval & Context Receipts (Transparency)**
   * **Explainable file discovery.** When the user names no files, Ripple ranks candidates using:
     1. **Git co-change history** (files that frequently commit together in past PRs).
     2. **Test & doc pairing** (by naming convention and import graph neighbors).
     3. **BM25-style lexical matching** against symbols and task descriptions.
   * **Strict Token Budget Packing.** Generates structural definition maps rather than raw file dumps (saving up to 60% of context tokens).
   * **Inspectable Context Receipt.** The agent panel shows an exact receipt of which files were selected, why they were chosen (with co-change commit counts), and what was evicted.

3. **TrueForge-Native Agent Loop (Harness Integration)**
   * **Local Harness Mode.** The agent loop runs entirely on TrueForge (`@truefoundry/trueforge@0.185.1`). The extension never calls any AI model provider directly.
   * **Embedded MCP Tool Server.** Exposes editor capabilities (`read_file`, `search_workspace`, `retrieve_context`, `propose_write`, `run_command`) over `127.0.0.1` with bearer token authentication.
   * **Approval-Gated Tool Lifecycles.** TrueForge's `tool.approval_required` event triggers the inline diff review; human approval resumes the turn.
   * **Context Compaction.** Automatically summarizes older execution turns when the thread crosses 12,000 input tokens.
   * **Automatic Multi-Model Failover.** If the primary remote model (Gemini 3.5 Flash-Lite) drops or encounters rate limits, Ripple automatically fails over to a local offline model (Qwen 2.5 Coder 7B on Ollama) without user intervention or workspace corruption.

---

## 2. System Architecture

```mermaid
graph TD
    User([Developer in VS Code]) <-->|Inline Edit Ctrl+; / Agent Panel| Ext[VS Code Extension Host]
    
    subgraph Extension_Plumbing [Extension Host Runtime]
        Ext --> TxMgr[Transaction Manager<br/>Fenced Staging & Atomic Undo]
        Ext --> Retr[Ripple Retriever<br/>Co-Change, Graph & Budget]
        Ext --> MCP[Local MCP Tool Server<br/>127.0.0.1 Bearer Auth]
    end

    MCP <-->|Tool Execution & Approval| TF[TrueForge Agent Harness<br/>Local Mode :8790]
    
    subgraph Model_Routing [Model Adapter Layer]
        TF <-->|Turns & Streaming| Adapter[Dual-Model Adapter<br/>gemini-proxy.mjs]
        Adapter -->|Primary| M1[Gemini 3.5 Flash-Lite<br/>Google AI Studio Free Tier]
        Adapter -.->|Failover on Outage| M2[Qwen 2.5 Coder 7B<br/>Local Ollama 127.0.0.1:11434]
    end

    TxMgr -->|Diff Review & Codelens| Review[Per-Hunk Review Tab]
    Review -->|Accept / Reject| Ext
```

---

## 3. Quick Start (From a Clean Clone)

Follow this setup to run Ripple from scratch. Full operational runbook: [docs/runbook.md](docs/runbook.md).

### Prerequisites
- Node.js 22+ or 24+
- Python 3.10+ with `pytest`
- (Optional for local fallback) [Ollama](https://ollama.ai) with `qwen2.5-coder:7b`

### 1. Clone & Install Dependencies
```powershell
git clone <repository-url>
cd ripples
npm install
```

### 2. Configure Model Credentials
Keys are read from a git-ignored `.env` file (never committed):
```powershell
# Create .env in root
Set-Content -Path ".env" -Value "GEMINI_API_KEY=your_gemini_api_key_here"
```
*(You can obtain a free key at [Google AI Studio](https://aistudio.google.com/)).*

### 3. Prepare the Demonstration Repository
Clone `pallets/flask` at pinned release tag `3.1.3` (commit `22d92470`):
```powershell
npm run demo:prepare
```

### 4. Start the TrueForge Stack
In a dedicated terminal, launch TrueForge and the model adapter:
```powershell
npm run stack
```
*Starts TrueForge on `http://localhost:8790` with loopback whitelist enabled (`OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`), boots the adapter, and registers model definitions.*

### 5. Launch Ripple in VS Code
Open this folder in VS Code and press **F5** (or run the launch configuration: **Run Ripple on the Flask demo**).
- Open any file in the workspace (e.g. `src/flask/helpers.py`).
- Select code and press `Ctrl+;` for inline edit.
- Click the Ripple icon in the sidebar to open the Agent Panel.

---

## 4. Verification Suite (The Three Fixed Tasks)

The competition evaluation tests Ripple against `pallets/flask` (tag 3.1.3):

### Task A — Inline Edit (Control)
- **Action:** Open `src/flask/helpers.py`, select `get_debug_flag`, press `Ctrl+;`, and instruct:
  > *"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."*
- **Review:** Accept hunks in the diff review tab.
- **Verification:**
  ```powershell
  FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
  # Output: False
  ```
- **Undo:** Trigger `Ripple: Undo Last Applied Change` (`Ctrl+Z`). File reverts cleanly; `git status` is clean.

### Task B — Agent Mode (Transparency & Multi-File Discovery)
- **Action:** In the agent panel, with **no files named**, instruct:
  > *"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as '***'. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."*
- **Outcome:**
  - Ripple retrieves context and shows the **Context Receipt** in the panel.
  - Automatically identifies and edits **3 files**: `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`.
  - TrueForge compacts context at the 12,000 token threshold.
- **Verification:**
  ```powershell
  pytest tests/test_cli.py -q
  # Output: 59 passed
  ```
- **CLI Output:**
  ```powershell
  flask config
  # Output: {"SECRET_KEY": "***", "DEBUG": false, ...}
  ```
- **Rollback:** One undo restores all 3 files together; `git status` returns to clean.

### Task C — Resilience & Automatic Local Fallback
- **Action:** Stop the primary model endpoint to simulate a connection refusal (`ECONNREFUSED`), then repeat Task A.
- **Outcome:**
  - Adapter detects connection failure, performs exponential retry, and automatically fails over to local `ollama/qwen-coder-tools-7b`.
  - Editor never blocks; diff tab opens with proposed edit from the local model.
  - Rejecting the proposal leaves the repository completely untouched (`git status` clean).

Automated end-to-end evaluators:
```powershell
npm run task-a    # Runs Task A automated evaluation in clean host
npm run task-b    # Runs Task B multi-file automated evaluation
npm run task-c    # Runs Task C failover evaluation
```

---

## 5. Competition Scorecard & Video Timestamps

Demonstrated in the official submission video: **[Ripple-Demo-Competition.mp4](docs/scorecard.md)** (Runtime: `03:53.2` $\le$ 4 min):

| Criterion | Video Time | Verified Claim & Evidence |
|---|---|---|
| **A1 Inline Edit (10 pts)** | `00:34` | In-editor diff rendering with per-hunk independent Accept/Reject; verified `FLASK_DEBUG=off` $\rightarrow$ `False`. |
| **A2 Agent Mode (10 pts)** | `02:14` | Autonomous discovery & modification of 3 files (`cli.py`, `test_cli.py`, `cli.rst`) with no files named. |
| **A3 Streaming & Cancel (10 pts)** | `01:18` | Live token streaming; cancellation aborts turn immediately in 16–35 ms; workspace left 100% clean. |
| **B1 Context Assembly (15 pts)** | `01:39` | Hard-budgeted map retrieval; receipt panel details file selection rationale and git co-change commits. |
| **B2 Diff Safety (10 pts)** | `01:11` | Zero silent writes to disk; all hunks staged in-memory; single-action atomic undo restores workspace. |
| **B3 Resilience (10 pts)** | `03:11` | Primary endpoint failure detected; automatic failover to local Qwen 7B; workspace clean on rejection. |
| **B4 TrueForge Depth (10 pts)** | `02:06` | Native MCP server over loopback; approval-gated write tool; context compaction visible in TrueForge. |
| **C1 Demo Video (10 pts)** | `00:00` | Complete Tasks A, B, and C in order; all terminal outputs legible; runtime 3m 53s ($<$ 4 min). |
| **C2 Write-up (15 pts)** | — | [docs/writeup.pdf](docs/writeup.pdf) — Complete 3-page engineering report covering all 8 required headings. |

---

## 6. Project Layout

```
ripples/
├── agents/                       # Pinned TrueForge agent specs
│   ├── ripple-agent.json         # Full multi-file agent (compaction threshold: 12k)
│   └── ripple-inline.json        # Lean inline-edit agent
├── config/
│   └── trueforge.models.example.json  # Sanitized model provider template (zero secrets)
├── docs/
│   ├── writeup.md                # 8-heading competition write-up draft
│   ├── writeup.pdf               # Compiled 3-page competition write-up PDF
│   ├── runbook.md                # Engineering runbook & troubleshooting manual
│   └── validation-report.md      # Full verification logs from clean runs
├── scripts/
│   ├── start-stack.mjs           # One-command boot for TrueForge + adapter + models
│   ├── gemini-proxy.mjs          # Multi-provider model proxy (streaming, keep-alive)
│   ├── setup-models.mjs          # TrueForge provider registration script
│   └── demo/                     # End-to-end video recording & editing automation
├── src/
│   ├── core/                     # Pure TypeScript, zero VS Code imports (unit-tested)
│   │   ├── transactions.ts       # Fenced edit buffers, epoch tracking, atomic undo
│   │   ├── retrieve.ts           # Co-change mining, pairing graph, lexical budget packer
│   │   └── budget.ts             # Adaptive context budget allocations
│   ├── mcp/                      # Embedded HTTP MCP Tool Server (loopback, bearer auth)
│   ├── trueforge/                # TrueForge SDK client, turn streaming, failover handler
│   └── ui/                       # Diff review tabs, CodeLens decorations, Agent Panel webview
└── test/                         # 168 Vitest unit tests (transactions, retrieve, mcp, fallback)
```

---

## 7. Starting Point & Open Source Attribution

Ripple was built from scratch and is **not a fork**. To ensure rock-solid in-editor UX, two UI components adapt code from [Continue](https://github.com/continuedev/continue) (commit `5522c6f44ca0ac3528b37244818fbfa39b5af470`, Apache License 2.0; see [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)):

1. `src/ui/decorations.ts`: Adapted line-level diff decorations (`green` / `red` gutter markers); added boundary index guards and lifecycle disposal.
2. `src/ui/hunkCodeLens.ts`: Adapted per-line CodeLens provider; rewired to Ripple's transaction hunk IDs (`ripple.acceptHunk`, `ripple.rejectHunk`) and added file-level batch review.

**Note:** Continue's agent loop, state manager, and model callers were completely excluded. The agent loop runs natively on **TrueForge**.

### Runtime Dependencies
- `@truefoundry/trueforge-sdk` (`0.185.0`) — MIT
- `@modelcontextprotocol/sdk` (`1.32.2`) — MIT
- `zod` (`4.6.7`) — MIT

---

## 8. License

This project is licensed under the **MIT License** — see [LICENSE](LICENSE).  
Adapted UI files remain under the **Apache License 2.0** ([licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)).
