# AGENTS.md: Ripple

This file is the project memory for any coding agent working in this repository
(Claude, Cursor, Cline, Codex, Copilot). Read it fully before changing anything.

## 1. Mission

Build **Ripple**, a VS Code extension that is a coding agent whose agent loop runs
on **TrueForge** (https://github.com/truefoundry/trueforge), for Round 1 of the
TrueFoundry Forge-a-thon (Techfest IIT Bombay 2026-27).

- Hard deadline: **Fri 20 Nov 2026, 23:59 IST**. Internal deadline: 18:00 IST.
- Solo build. Owner: Sivaguru.
- Deliverables: public GitHub repo, demo video (max 4 min), write-up PDF (1 to 3 pages).
- Work plan: https://claude.ai/artifact/Q353ZEa4xZyfAY7wP9LwRJ

## 2. Eligibility rules (breaking any one disqualifies the entry)

1. The agent loop runs on TrueForge in local mode. Never write a homegrown loop.
2. The extension is a TrueForge client: it creates sessions and sends turns via
   `@truefoundry/trueforge-sdk` (or the HTTP API) and renders streamed events.
3. The extension must **never call a model provider directly**. Models are
   configured in TrueForge only. No provider may be hard-coded.
4. Editor capabilities are exposed to the agent as **MCP tools** served by the
   extension. The agent, not the extension, decides what to read and change.
5. No API keys or secrets in the repo or its git history. Ship
   `config/trueforge.models.example.json` only.
6. Borrowed code must keep its licence and be declared in the README with
   repository URL and exact commit. Do not copy code from other Forge-a-thon
   entries. Do not use AGPL code.
7. The agent definitions used in the demo must be committed under `agents/`.

## 3. What Ripple is

Three parts. Do not add a fourth.

1. **Fenced edit transactions.** No tool writes to disk directly. Every edit is
   staged, reviewed hunk by hunk, and applied as one undoable `WorkspaceEdit`.
   Each run has an epoch; cancelling or failing bumps it, and any tool call
   carrying an old epoch is rejected. Hunk ID = hash(base text, range, new text),
   so retries are idempotent and stale proposals fail cleanly.
2. **Ripple retrieval.** `retrieve_context` ranks files by (a) co-change in git
   history, (b) test/doc pairing and import neighbours, (c) lexical match, then
   packs them into a hard token budget. It returns a receipt: file, reason,
   evidence, tokens, and what was evicted. The receipt is shown in a panel.
3. **TrueForge-native wiring.** MCP server inside the extension host on
   localhost with a bearer token. TrueForge tool approval is what opens the diff
   review. A second configured model takes over when the first fails.

## 4. Scope

In: inline edit with per-hunk accept/reject; agent panel with streaming and
cancel; `@file` and `@symbol` mentions; retrieval with budget and receipt;
undo of an applied change; retry and model fallback.

Out (never build): tab completion, embeddings or vector index, Code Mode,
sandbox, hosted backend, auth, settings UI, Marketplace publishing.

Stretch only if Thursday is free: repo-map PageRank signal, scout subagent,
deferred-tool tuning.

## 5. Architecture

```
VS Code extension host
  ├─ MCP server (HTTP, 127.0.0.1, bearer token)
  │    read_file · search_workspace · retrieve_context
  │    propose_write (write-annotated, approval-gated) · run_command (approval-gated)
  ├─ TrueForge client (SDK): sessions, turn stream, approval events, cancel
  ├─ TransactionManager: epoch, staged buffers, hunks, atomic apply, undo
  ├─ Retriever: cochange · pairing · lexical · budget packer · receipt
  └─ UI: agent panel webview · receipt view · inline hunk review · inline-edit command
TrueForge (local, npx @truefoundry/trueforge) ── model A, fallback model B
```

Suggested layout:

```
agents/ripple-inline.json     lean agent for inline edit
agents/ripple-agent.json      full agent for agent mode
config/trueforge.models.example.json
src/core/        no `vscode` imports; unit-testable (transactions, retrieval, budget)
src/mcp/         MCP server and tool handlers
src/trueforge/   SDK client, event handling, fallback
src/ui/          panel, receipt, hunk review, inline edit
test/            vitest unit tests for src/core
```

## 6. Tool contracts

| Tool | Behaviour |
|---|---|
| `read_file(path, start?, end?)` | Returns text with line numbers. Reads the staged version if one exists for this run. |
| `search_workspace(query, glob?)` | ripgrep. Capped result count. |
| `retrieve_context(task, budget_tokens?)` | Returns ranked files plus the receipt. Never exceeds the budget. |
| `propose_write(epoch, path, edits[])` | Stages hunks only. Approval pause opens review. Result lists accepted and rejected hunk IDs with the user's reason. |
| `run_command(epoch, command)` | Approval-gated. Runs in the workspace root, output truncated. |

Rules: a tool call with a stale epoch returns an error and changes nothing.
A rejected hunk is reported to the agent, never silently dropped.

## 7. The three fixed tasks (acceptance tests)

Repository under test: `pallets/flask` at tag `3.1.3` (commit `22d92470`), cloned
with full history.

- **Task A, inline edit.** Select `get_debug_flag` in `src/flask/helpers.py` and
  instruct: "Treat the values 'off' and 'n' as false as well, case-insensitively,
  and update the docstring to list every value that is treated as false."
  Verify: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False`.
- **Task B, agent mode, no files named.** "Add a new built-in CLI command flask
  config that prints the loaded application's configuration as JSON, masking the
  values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must
  appear in flask --help, be covered by a test, and be documented alongside the
  other built-in commands."
  Verify: `pytest tests/test_cli.py -q` passes; the command prints masked JSON;
  the diff touches at least three files; the receipt panel shows why each was chosen.
- **Task C, resilience.** Configure an unreachable endpoint or invalid key and
  repeat Task A. Verify: editor stays responsive, fallback model takes over with
  no user action (or a clear error after retries), and `git status` is clean.

Must work with any model TrueForge is configured with, including a small local one.

## 8. Scoring targets (100 points)

| Criterion | Top anchor to hit |
|---|---|
| A1 Inline edit (10) | Diff in editor with per-hunk accept and reject |
| A2 Agent mode (10) | Discovers and edits 3+ files unprompted |
| A3 Streaming/cancel (10) | Immediate cancel, workspace consistent |
| B1 Context (15) | Budgeted retrieval, visibly at work, files and reasons shown |
| B2 Diff safety (10) | Per-hunk review and working undo, on screen |
| B3 Resilience (10) | Automatic fallback to second model, workspace unchanged |
| B4 Integration (10) | MCP tools, approval drives review, one context-engineering feature |
| C1 Video (10) | A, B, C in order, verified on screen |
| C2 Write-up (15) | Eight headings, scorecard with timestamps, honest limitations |

## 9. Open R&D questions (answer before building on them; record answers here)

All answers below were **verified by running them** on 16 Nov against TrueForge
0.185.1 (isolated SQLite), in a real VS Code 1.142 Extension Development Host
(`npm run test:vscode`) and in headless scripts using the same `src/` modules.
Models: a scripted mock, and a real local `qwen2.5-coder` 7B on Ollama.
Full evidence: `docs/verification-day1.md`.

- [x] Exact approval event names and resume call in the pinned SDK version
      (the 0.185.0 release changed the turn lifecycle).
      **Answer:** stream opens with `turn.created` (gives `turnId`). Approval
      needed → `tool.approval_required` (`toolCalls: [{ id, sourceEventId }]`,
      `threadId`), then `turn.update` with `state.status: "paused"`. Resume on the
      same turn: (1) `client.sessions.subscribeToTurn(sessionId, turnId,
      { afterEventId: lastEventId })`, (2) `client.sessions.createTurnEvents(sessionId,
      turnId, { events: [{ type: 'user.tool_approval', threadId, toolCallId,
      approval: { status: 'allow' } | { status: 'deny', reason } }] })`, (3) read the
      subscription to `turn.done`. Verified for allow and deny. A denied call never
      reaches the MCP server; the model gets `tool.response`
      `User denied tool call: <reason>` and the turn ends `done`.
      Docs: https://trueforge.dev/announcements/turn-lifecycle-0-185-0 ,
      https://trueforge.dev/api/use-agent
- [x] How a local MCP server is registered, and the localhost allowlist setting.
      **Answer:** `client.settings.mcpServers.createOrUpdate({ manifest: { type:
      'remote', name, description, url, auth: { type: 'header', headers:
      { Authorization: 'Bearer …' } } } })`, then attach by name in the agent's
      `mcp_servers`. Verified: `mcp.initialize servers=[ripple:streamable-http]`.
      **Allowlist (not in the docs; found in the shipped server code):** start
      TrueForge with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`. Verified: without
      it, registration fails with HTTP 400 `Outbound URL blocked for host
      "127.0.0.1"`; the extension logs the fix when it sees this. Do not use
      `NETWORK_POLICY_ENABLED=false`.
      **Also verified:** on Windows TrueForge listens on `[::1]` only, so
      `127.0.0.1:8790` is refused. Clients must use `http://localhost:8790`.
      Docs: https://trueforge.dev/mcp-servers , SDK `reference.md` "Settings McpServers".
- [x] Whether `require_approval_for_tools` can force approval per tool.
      **Answer:** yes. Accepts `@all`, `@write`, `@destructive` or literal names;
      default `["@write", "@destructive"]`. Verified: `["propose_write"]` pauses
      `propose_write` and not `read_file`. Use literal names.
      Docs: https://trueforge.dev/create-agent/overview
- [x] Whether TrueForge supports model fallback natively; if not, how to switch
      the model on a session via the API.
      **Answer:** no native failover (https://trueforge.dev/models calls automatic
      selection "planned"). Verified switch: an unreachable model ends the turn with
      `turn.done status=error`, `[Model Error] Cannot connect to API: bad port`, in
      126 ms. `client.sessions.update(sessionId, { agent: { spec } })` with another
      model, then a new turn on the same session, completes `done` on the new model.
      A cold local model can also fail after about 60 s with `Headers Timeout Error`;
      fallback must treat that as a failure too.
- [x] Which event carries token deltas and how to cancel a running turn.
      **Answer:** `model.message.delta` (`content`, plus `toolCalls` fragments),
      after a `model.message` with the same `id`; merge with `mergeEventDelta`.
      Verified: tool calls arrive only in deltas. Cancel: `client.sessions.cancel(
      sessionId)`. Verified on a **paused** turn: state becomes `cancelled`, and a
      late `createTurnEvents` gets HTTP 409 `Turn is not accepting events` (the
      client must treat that 409 as already cancelled; not yet handled).
      **Not yet verified:** cancel of a running turn.
      Docs: https://trueforge.dev/api/quickstart , https://trueforge.dev/api/use-agent

Other verified facts:
- Small local models: stock `qwen2.5-coder:7b` on Ollama writes tool calls as JSON
  text, not `tool_calls`. A derived local model `qwen2.5-coder-tools:7b` (template
  without `<tool_call>` tags) fixes it; registered in TrueForge as custom provider
  `ollama` at `http://127.0.0.1:11434/v1`. `llama3` is rejected ("does not support
  tools").
- With that model the agent copied the `read_file` line-number gutter into
  `new_text`, re-proposed the same edit after approval with epoch 1 instead of 0,
  and once claimed the file "has been updated". Fenced transactions (section 3)
  must handle all three.
- `preload: false` (default) hides tools behind `list_tools`, `get_tool_info`,
  `get_tool_output_schema`, `call_tool`. Not yet run: the Day 1 agent uses
  `preload: true`.
- The SDK's CJS build cannot be `require`d by Node; esbuild bundles its ESM build.

Pinned versions: TrueForge `0.185.1` (start as `npx @truefoundry/trueforge@0.185.1`),
SDK `@truefoundry/trueforge-sdk 0.185.0`, MCP SDK `@modelcontextprotocol/sdk 1.32.2`.
Do not upgrade.

## 10. Working rules for agents

- Check the TrueForge docs (trueforge.dev) before using any SDK call. Do not
  guess API names; competitor READMEs and older blog posts may be out of date.
- Keep `src/core` free of `vscode` imports and cover it with unit tests.
- Small commits with clear messages; judges read the git history.
- Never commit `config/*.json` except the `.example.json` file.
- Platform is Windows; use cross-platform paths and avoid bash-only scripts.
- If a change would violate section 2 or add anything from "Out", stop and ask.
- One writer at a time in `E:\ripples`. A second agent only reads, or works in
  its own checkout (`git worktree add --detach ..\ripple-verify master`). Tests
  are run from a clean checkout, never from a tree someone is editing.
- Update the status table below at the end of every work session.

## 11. Status

| Day | Gate | State |
|---|---|---|
| Mon 16 Nov | Tool call round-trips through TrueForge; approval event reaches the extension | **Passed.** In a real VS Code host with the mock and with a local qwen2.5-coder 7B: `read_file`, approval pause, allow and deny, README unchanged on disk. Still to do by hand: click Allow/Deny on the notification (the test answers through a test-only argument) |
| Tue 17 Nov | Task A passes; cancelled run leaves `git status` clean | **Passed (16 Nov)** in a real VS Code host on a flask 3.1.3 clone with `ollama/qwen-coder-tools-7b` (2 runs) and the mock: review opens in an editor tab with per-hunk Accept/Reject; `FLASK_DEBUG=off` prints `False`; one Ctrl+Z restores the file; cancel mid-stream ends the turn in 11-36 ms with `git status` clean. Mock also passes partial accept and reject-all (a failed rerun at reject-all passed on retry; a second session was sharing TrueForge). Gaps: the 7B model changes the code but not the docstring (1 hunk, not 2); not yet clicked by hand |
| Wed 18 Nov | Task B passes with receipt visible | **Passed with the scripted mock only (16 Nov); not yet run with a real model.** In a VS Code host (installed build, not the pinned 1.142) on a flask 3.1.3 clone: the mock's scripted edits are staged in `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`, reviewed per hunk and written as one `WorkspaceEdit`; the receipt lists `tests/test_cli.py` (48 commits) and `docs/cli.rst` (19 commits) with co-change evidence inside 8000 tokens; `pytest tests/test_cli.py -k test_config_command` passes; `flask --help` lists `config`; `SECRET_KEY` and `API_TOKEN` are masked; one `ripple.undoLastChange` leaves `git status` clean. Gaps: because the edits are scripted, the agent discovering the files itself is unproven; full `pytest tests/test_cli.py -q`, PASSWORD masking and cancel in agent mode are not asserted; `run_command` is preloaded, not deferred; @mentions are read from the agent's `task` argument, not the user's prompt |
| Thu 19 Nov | Task C passes; Task B 8 of 10; README works from clean clone | Not started |
| Fri 20 Nov | Video, write-up and repo public and submitted by 18:00 IST | Not started |
