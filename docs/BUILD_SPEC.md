# Ripple: Technical Build Specification & Architecture Reference

**System:** Ripple — An Editor-Native Coding Agent on TrueForge  
**Target Platform:** Visual Studio Code Extension Host  
**Orchestration Engine:** TrueForge Local Runtime (`@truefoundry/trueforge@0.185.1`)  
**Client SDK:** `@truefoundry/trueforge-sdk@0.185.0`  
**Protocol Layer:** Model Context Protocol (MCP TypeScript SDK `1.32.2`)  
**Target Repository Under Test:** `pallets/flask` @ tag `3.1.3` (commit `22d92470`)  
**Repository:** [https://github.com/Sivaguru-2008/ripple](https://github.com/Sivaguru-2008/ripple)  
**Author:** Sivaguru Murugan (@Sivaguru-2008)  

---

## 1. Executive Summary & Problem Statement

Autonomous coding assistants frequently fail in real-world software engineering due to four fundamental failure modes:
1. **Uncontrolled File Modifications:** Agents silently overwrite working directories, making rollbacks difficult and injecting unintended regressions.
2. **Context Window Exhaustion:** Repositories exceed model context windows; agents hallucinate symbols or miss critical test/documentation counterparts.
3. **Black-Box Opacity:** Developers cannot inspect why specific files were read or what context was evicted.
4. **Fragility & Provider Downtime:** When an upstream API stalls or throws rate limits, the entire agent session crashes, leaving half-applied edits.

**Ripple** solves these challenges by combining:
- **Fenced Edit Transactions:** In-memory edit buffers with cryptographic hunk hashing, explicit developer diff reviews, and single-action atomic rollbacks.
- **Budgeted Multi-Signal Retrieval:** Hard-budgeted context packing combining git commit co-change history, test/doc pairing graphs, and lexical search, backed by an auditable Context Receipt.
- **TrueForge-Native Architecture:** Complete delegation of the turn and agent loop to TrueForge in local mode, exposing editor capabilities through loopback MCP tools, utilizing TrueForge approval gates to trigger reviews, and providing automated resilience failover.

---

## 2. Eligibility & Architecture Invariants

To comply with the official TrueFoundry Forge-a-thon competition rules:

| Invariant | Specification & Implementation |
|---|---|
| **Loop Location** | The agent loop runs exclusively inside **TrueForge** local mode. No custom loop state machine exists in the extension host. |
| **Model Access** | The VS Code extension **never** communicates with a model provider directly. All model queries route through TrueForge. |
| **Tool Exposure** | All editor capabilities (`read_file`, `search_workspace`, `retrieve_context`, `propose_write`, `run_command`) are exposed as standard **MCP tools** over an HTTP loopback socket (`127.0.0.1`). |
| **Security & Secrets** | Zero API keys or secrets are stored in code or git history. Configurations use `.env` and `config/trueforge.models.example.json`. |
| **Open Source Licensing** | Upstream UI diff components adapted from Continue are declared with commit hash [`5522c6f44ca0ac3528b37244818fbfa39b5af470`](https://github.com/continuedev/continue) under the Apache 2.0 license. |

---

## 3. System Architecture & Topology

```
┌────────────────────────────────────────────────────────────────────────┐
│                        VS Code Extension Host                          │
│                                                                        │
│   ┌──────────────────────────┐      ┌──────────────────────────────┐   │
│   │   UI / Review System     │      │     TransactionManager       │   │
│   │  • Inline Diff CodeLens  │◄────►│  • Epoch tracking            │   │
│   │  • Side Panel Webview    │      │  • In-memory staged hunks    │   │
│   │  • Receipt & Evicted HUD │      │  • Atomic apply & undo       │   │
│   └─────────────┬────────────┘      └──────────────┬───────────────┘   │
│                 │                                  │                   │
│                 ▼                                  ▼                   │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                  Embedded Loopback MCP Server                  │   │
│   │             (HTTP 127.0.0.1:<ephemeral>, Bearer Auth)          │   │
│   │  • read_file          • search_workspace                       │   │
│   │  • retrieve_context   • propose_write (Approval-Gated)         │   │
│   │  • run_command (Approval-Gated)                                │   │
│   └─────────────────────────────▲──────────────────────────────────┘   │
└─────────────────────────────────┼──────────────────────────────────────┘
                                  │ JSON-RPC / SSE
                                  │ (MCP Tool Execution)
┌─────────────────────────────────▼──────────────────────────────────────┐
│                    TrueForge Local Agent Runtime                       │
│                     (http://localhost:8790)                            │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │  Turn State Machine & Streaming Loop                           │   │
│   │  • Turn Lifecycle: created -> streaming -> paused -> done      │   │
│   │  • Approval Intercept: user.tool_approval (allow | deny)       │   │
│   │  • Context Compaction: Triggers at 12,000 / 20,000 tokens      │   │
│   └─────────────────────────────▲──────────────────────────────────┘   │
└─────────────────────────────────┼──────────────────────────────────────┘
                                  │ OpenAI-compatible API
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Configured Model Backends                       │
│  • Primary Model:    gemini/gemini-3-1-flash-lite                      │
│  • Secondary/Backup: gemini/gemini-3-5-flash-lite / ollama/qwen-7b     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Technical Pillar 1: Fenced Edit Transactions

**Module:** `src/core/transactions.ts` (100% pure TypeScript, zero VS Code imports)

### 4.1 Run Isolation & Bearer Security
Every transaction is bounded to a unique run:
- A run identifier (`id: string`) and ephemeral bearer token (`token: randomBytes(24).toString('hex')`) are minted on turn creation.
- The token is passed to TrueForge inside the remote MCP server URL: `http://127.0.0.1:<port>/mcp?token=<token>`.
- Any MCP request without a valid, active token is immediately rejected with HTTP 403.
- If a run is cancelled or fails, its state transitions to `cancelled` or `failed`. Any subsequent tool call carrying that token fails cleanly.

### 4.2 Content-Addressed Hunk Hashing
To prevent race conditions, duplicate edits, and stale proposals, each proposed edit hunk is hashed deterministically:
$$\text{HunkID} = \text{SHA256}(\text{base\_text} + \text{start\_line} + \text{end\_line} + \text{new\_text})[:16]$$
- **Idempotency:** Re-proposing an identical edit produces the exact same Hunk ID.
- **Stale Protection:** If base text changes on disk, the base text calculation mismatches and rejects stale proposals.

### 4.3 Transaction State Lifecycle
```
[Propose Edit] ──> [Staged Buffer] ──> [Pending Approval]
                                              │
                    ┌─────────────────────────┴────────────────────────┐
                    ▼                                                  ▼
          [Developer Accepts]                                [Developer Rejects / Cancel]
                    │                                                  │
                    ▼                                                  ▼
             [Applied Hunk]                                    [Hunk Discarded]
                    │                                                  │
                    ▼                                                  ▼
        [Atomic WorkspaceEdit]                             [Workspace Kept Clean]
```

### 4.4 Supported Edit Formats
The transaction manager handles three edit models:
1. **Replacement Edit:** `{ old_text: string, new_text: string }`
   - Matches `old_text` against the current file buffer (with whitespace/indentation tolerance).
2. **Insertion Edit:** `{ insert_after_line: number, line_text: string, new_text: string }`
   - Verifies that `line_text` matches the text at line `insert_after_line` before inserting.
3. **File Creation:** `{ old_text: "", new_text: string }`
   - Stages a new file in memory without touching disk until accepted.

---

## 5. Technical Pillar 2: Ripple Retrieval & Budgeting

**Modules:** `src/core/retrieve.ts`, `src/core/cochange.ts`, `src/core/budget.ts`

### 5.1 Three-Signal Candidate Ranking
When `retrieve_context` executes, it scans the repository and ranks candidate files using three orthogonal signals:

1. **Git Co-Change History ($S_{\text{cochange}}$):**
   Mines the workspace git commit log ($N=1000$ commits). If file $A$ frequently changes alongside active/modified files $B$:
   $$S_{\text{cochange}}(A, B) = \frac{|\text{Commits}(A \cap B)|}{|\text{Commits}(A \cup B)|}$$
2. **Pairing & Import Topology ($S_{\text{pair}}$):**
   Identifies architectural companion files:
   - Source-to-Test: `src/flask/cli.py` $\leftrightarrow$ `tests/test_cli.py`
   - Source-to-Doc: `src/flask/cli.py` $\leftrightarrow$ `docs/cli.rst`
   - Direct AST/syntax imports: `from flask.cli import ...`
3. **Lexical Relevance ($S_{\text{lexical}}$):**
   Evaluates instruction keyword density against file symbols and docstrings.

### 5.2 Hard Token Budget Packer
- Context is packed into an explicit token budget (default: 8,000 tokens; dynamically scaled based on model window).
- **Map Retrieval Style:** Emits file outlines, definitions, and line ranges rather than full file dumps, reducing token consumption by $\sim 56\%$.
- **The Context Receipt:** Returns structured telemetry explaining:
  - Files included and token costs
  - Evidence for inclusion (e.g., `tests/test_cli.py [48 shared commits with cli.py, strength 0.45]`)
  - **Evicted Candidates:** Lower-ranked files that were omitted to enforce budget safety.

---

## 6. Technical Pillar 3: TrueForge Harness Integration

**Modules:** `src/trueforge/client.ts`, `src/trueforge/runner.ts`, `src/mcp/server.ts`

### 6.1 Session & Turn Event Pipeline
```typescript
// Turn Lifecycle Subscription
const stream = await client.sessions.createTurnEventsSubscription(sessionId, turnId);
for await (const event of stream) {
  switch (event.type) {
    case 'model.message.delta':
      panel.appendStreamDelta(event.delta);
      break;
    case 'tool.approval_required':
      // Halts agent turn; opens VS Code review tab
      const proposal = transactionManager.getProposal(event.toolCallId);
      openDiffReview(proposal);
      break;
    case 'turn.done':
      handleTurnCompletion(event.status);
      break;
  }
}
```

### 6.2 Context Compaction
- Compaction trigger configured in `agents/ripple-agent.json`:
  ```json
  "context_management": {
    "compaction": {
      "enabled": true,
      "trigger": { "type": "input_tokens", "value": 12000 }
    }
  }
  ```
- When active turns exceed 12,000 input tokens, TrueForge compresses earlier turns into a structured summary.
- Ripple intercepts `thread.context_compaction_*` events, updates the side panel HUD, and automatically injects a state reminder informing the model of accepted hunks so it does not repeat completed work.

### 6.3 Autonomous Model Failover (Resilience)
- If the primary model endpoint experiences network drops, connection refusals (`ECONNREFUSED`), or 503 overloads:
  1. The runner performs exponential backoff retries ($N=1$).
  2. If the failure persists, the runner calls `client.sessions.update(sessionId, { agent: { spec } })` switching `model.name` to `ripple.fallbackModel` (`ollama/qwen-coder-tools-7b`).
  3. The turn resumes with previously accepted hunks intact and zero developer disruption.

---

## 7. MCP Tool Definitions & JSON Schemas

The embedded MCP server exposes 5 endpoints:

### 1. `read_file`
Reads a file from the workspace or from the active staged buffer if modified.
```json
{
  "name": "read_file",
  "description": "Reads lines from a file with line numbers. Reads staged buffer if modified in this run.",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Workspace-relative file path" },
      "start": { "type": "integer", "description": "1-based starting line number" },
      "end": { "type": "integer", "description": "1-based ending line number (inclusive)" }
    },
    "required": ["path"]
  }
}
```

### 2. `search_workspace`
Executes workspace-wide ripgrep search.
```json
{
  "name": "search_workspace",
  "description": "Searches code symbols across the workspace with line numbers.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search pattern or symbol" },
      "glob": { "type": "string", "description": "Optional file glob filter" }
    },
    "required": ["query"]
  }
}
```

### 3. `retrieve_context`
Performs budgeted multi-signal retrieval and outputs the Context Receipt.
```json
{
  "name": "retrieve_context",
  "description": "Ranks workspace files using git co-change, pairing, and lexical relevance within budget.",
  "parameters": {
    "type": "object",
    "properties": {
      "task": { "type": "string", "description": "Plain language task description" },
      "budget_tokens": { "type": "integer", "description": "Token budget cap (default: 8000)" }
    },
    "required": ["task"]
  }
}
```

### 4. `propose_write` (Approval Gated)
Stages hunks into memory and pauses TrueForge execution for user review.
```json
{
  "name": "propose_write",
  "description": "Proposes atomic modifications or file creations. Gated by user approval.",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Target file path" },
      "edits": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "old_text": { "type": "string" },
            "new_text": { "type": "string" },
            "insert_after_line": { "type": "integer" },
            "line_text": { "type": "string" }
          }
        }
      }
    },
    "required": ["path", "edits"]
  }
}
```

### 5. `run_command` (Approval Gated)
Executes terminal commands in the workspace root.
```json
{
  "name": "run_command",
  "description": "Runs shell commands in workspace root. Tail-truncated for test assertions.",
  "parameters": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "Terminal command to run" }
    },
    "required": ["command"]
  }
}
```

---

## 8. Verification & Acceptance Protocol

The competition evaluation validates three fixed tasks against `pallets/flask` (tag `3.1.3`):

### Task A — Inline Edit
- **Action:** Open `src/flask/helpers.py`, select `get_debug_flag`, press `Ctrl+;`:
  > *"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."*
- **Verification:**
  ```powershell
  FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
  # Output: False
  ```
- **Rollback:** `Ctrl+Z` (`Ripple: Undo Last Applied Change`) restores `git status` to clean.

### Task B — Agent Mode (Multi-File Discovery)
- **Action:** In Agent Panel, with **no files named**, instruct:
  > *"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as '***'. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."*
- **Outcome:**
  - Agent independently retrieves, modifies, and documents 3 files: `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`.
- **Verification:**
  ```powershell
  pytest tests/test_cli.py -q
  # Output: 59 passed
  
  flask config
  # Output: {"SECRET_KEY": "***", "DEBUG": false, ...}
  ```

### Task C — Resilience & Local Model Fallback
- **Action:** Terminate primary model endpoint (`127.0.0.1:8794`), then repeat Task A.
- **Outcome:**
  - Runner detects connection refusal, executes exponential retry, and automatically delegates to local `ollama/qwen-coder-tools-7b`.
  - Diff tab opens; rejecting proposal leaves `git status` completely clean.

---

## 9. Build, Test, and Packaging Pipeline

### Compilation & Bundling
- **TypeScript:** Strict type checking (`tsc --noEmit`).
- **Bundler:** `esbuild.mjs` targets Node 22+ CJS format, bundling dependencies into `dist/extension.js` (2.2 MB, compile time $\sim 150$ms).

### Automation Commands
```powershell
# 1. Clean installation
npm ci

# 2. Typecheck & Unit Tests
npm run typecheck    # tsc --noEmit
npm test             # vitest run (168 tests across 19 suites)

# 3. Compile Extension
npm run build        # esbuild -> dist/extension.js

# 4. Prepare Flask Demonstration Workspace
npm run demo:prepare # Clones pallets/flask @ 3.1.3 into ../flask-demo

# 5. Start TrueForge & Proxy Stack
npm run stack        # Boots TrueForge on :8790 + proxy on :8794

# 6. Automated Evaluation Runners
npm run task-a       # Automated Task A evaluator
npm run task-b       # Automated Task B multi-file evaluator
npm run task-c       # Automated Task C failover evaluator
```

---

## 10. Open Source Attribution

Ripple was developed from scratch and is not a fork of an existing agent. To provide high-quality in-editor diff rendering, two UI components adapt code from [Continue](https://github.com/continuedev/continue) (commit `5522c6f44ca0ac3528b37244818fbfa39b5af470`, Apache 2.0):

1. `src/ui/decorations.ts`: Line-level green/red diff gutter markers with boundary index guards.
2. `src/ui/hunkCodeLens.ts`: Line CodeLens provider rewired to Ripple's content-addressed hunk IDs (`ripple.acceptHunk`, `ripple.rejectHunk`).

Continue's agent loop, state manager, and model connectors were completely excluded. All orchestration runs natively on TrueForge.
