# Ripple: an editor-native coding agent on TrueForge

Draft, 18 Nov 2026. Items in [brackets] are to be filled in before submission.

## 1. Team

Sivaguru Murugan, solo. [College or employer]. GitHub: [handle].

## 2. Starting point

From scratch, not a fork. Two editor-side files adapt code from Continue
(https://github.com/continuedev/continue, commit `5522c6f44ca0ac3528b37244818fbfa39b5af470`,
Apache 2.0): the green and red line decorations of the diff review and the per-hunk
Accept/Reject CodeLens, rewired to Ripple's transaction hunks; licence, attribution and changes
are in the README. Continue's agent loop is not used. Runtime libraries: `@truefoundry/trueforge-sdk`
0.185.0, `@modelcontextprotocol/sdk` 1.32.2, `zod` (all MIT). TrueForge server pinned to 0.185.1.

## 3. Architecture on TrueForge

Ripple is a VS Code extension and a TrueForge client. It never calls a model; TrueForge runs the
agent loop in local mode.

- **Sessions and turns.** The extension creates a session per run from the committed agent
  definition (`agents/ripple-agent.json` for agent mode, `agents/ripple-inline.json` for inline
  edits), sends the request as a turn, and renders the streamed events
  (`model.message.delta` tokens, tool calls, approvals, compaction) in the agent panel.
- **Editor capabilities as MCP tools.** An MCP server inside the extension host (127.0.0.1,
  bearer token, one URL per run) exposes `retrieve_context`, `read_file`, `search_workspace`,
  `propose_write`, `run_command`, and `replace_selection` for inline edits. The agent decides
  what to read and change.
- **Approval drives the review.** `require_approval_for_tools` lists `propose_write` and
  `run_command`. A write pauses the TrueForge turn; Ripple opens the per-hunk review in the
  editor; the user's accept or reject decides the approval, and rejected hunks are reported back
  to the agent with the reason.
- **Fenced edit transactions.** No tool writes to disk. Each run stages hunks; accepted hunks of
  an agent run are held across files and written as one undoable `WorkspaceEdit` (before a test
  command, or at the end). Hunk ids hash base text, range and new text, so retries are
  idempotent and stale proposals fail cleanly. Cancel or failure rolls the run back.
- **Harness features used.** MCP connectors, per-tool approval, preloaded tools, and
  **compaction** as the context-engineering feature: the agent definition compacts the thread
  once it passes 20,000 input tokens; Ripple shows each compaction in the panel, and after one
  it tells the agent which changes are already made, so it does not redo them.
- **Resilience.** Model errors that waiting can fix (timeouts, overloads, connection errors) are
  retried once; then a second configured model (`ripple.fallbackModel`) takes over with no user
  action. An interrupted agent run keeps the edits the user already accepted and the next model
  continues from them; if every attempt fails, everything is rolled back. An agent that ends its
  turn while its own last test run failed is sent the failure and asked to fix it (at most
  twice) before the run may finish.

## 4. How context is selected

`retrieve_context` ranks files for the request, without embeddings, using (a) co-change in git
history, (b) test and documentation pairing by name and import neighbours, and (c) BM25-style
lexical and symbol matches; `@file` and `@symbol` mentions are pinned. It packs the result into a
hard budget: at most 8,000 tokens and at most 30% of the model's context window.

By default it sends a **map**, not file text: per file, its definitions or doc sections with line
ranges and the most relevant ranges; files under 500 tokens and pinned ranges are sent whole. The
agent then reads only the ranges it needs (`read_file` returns at most 120 lines). On Task B the
map of 6 files costs 2,038 tokens, against 4,655 tokens for 5 files as excerpts. Every result
carries a **receipt**, shown in the panel: file, reason, evidence (for example "changed with
src/flask/cli.py in 48 commits"), tokens, and what was evicted and why.

## 5. Model setup

| Model | Where it runs | Used for | Cost |
|---|---|---|---|
| `gemini-3.1-flash-lite` | Google AI Studio, free tier | agent mode (Task B) | $0 |
| `gemini-3.5-flash-lite` | Google AI Studio, free tier | inline edits (Task A); agent fallback | $0 |
| `qwen2.5-coder` 7B, tool-call template | Ollama on the laptop (RTX 5050, 8 GB) | inline fallback (Task C) | $0 |
| tried: `gemini-3-flash-preview`, `groq/gpt-oss-120b`, OpenRouter `nemotron-3-ultra:free` | free tiers | early Task B runs; stopped by quotas | $0 |

All models are configured in TrueForge only. `npm run models` registers the providers in
`config/trueforge.models.example.json`, reading keys from a git-ignored `.env`. Gemini, Groq and
OpenRouter are reached through `scripts/gemini-proxy.mjs`, a model endpoint registered in
TrueForge (not part of the extension) that smooths provider differences: it re-attaches Gemini's
thought signatures, removes the reasoning field Groq rejects, and keeps slow streams open past
TrueForge's 60 s header timeout. **Switching models:** change `model.name` (`provider/model`) in
`agents/*.json`, or `ripple.fallbackModel` in VS Code settings. Total spend: $0.

## 6. Scorecard

| Criterion | Video | Claim |
|---|---|---|
| A1 Inline edit | [mm:ss] | Diff rendered in the editor with per-hunk accept and reject |
| A2 Agent mode | [mm:ss] | Task B: the agent found and edited `cli.py`, `test_cli.py` and `cli.rst` with no files named |
| A3 Streaming and cancel | [mm:ss] | Tokens stream in the panel; cancel ends the run in 16 to 35 ms with `git status` clean |
| B1 Context assembly | [mm:ss] | Budgeted map retrieval; the receipt shows each file and why it was chosen |
| B2 Diff safety | [mm:ss] | Nothing reaches disk before acceptance; one undo restores the files |
| B3 Resilience | [mm:ss] | Task C: unreachable endpoint, retry, then the second model takes over; `git status` clean |
| B4 TrueForge depth | [mm:ss] | MCP tools, approval opens the review, compaction visible in the session |
| C1 Video | n/a | Tasks A, B, C in order, each verified on screen |
| C2 Write-up | n/a | This document |

Automated evidence (`docs/validation-report.md`): Task A and Task C pass in a real VS Code host on
fresh clones (`npm run task-a`, `npm run task-c`); Task B passed three times on
`gemini-3.1-flash-lite` (59 tests passed, `flask --help` lists `config`, masked JSON, undo clean)
and once completed via the fallback after the primary's daily quota ran out mid-run; 166 unit
tests.

## 7. Tools used

Claude Code (Anthropic) for most of the implementation, testing and documentation, and
[OpenAI Codex, one session on 18 Nov: confirm] for path hardening, the panel's
Content-Security-Policy and a retrieval cache, reviewed before committing. VS Code, Node.js 24,
Ollama, Python 3.12, pytest.

## 8. Known limitations, and another month

- **Slow and request-hungry on free models.** A Task B run takes 5 to 16 minutes and 70 to 160
  model requests; free daily quotas allow about 3 runs per model per day.
- **Pass rate not established.** Over 17 and 18 Nov, Task B on free Gemini Flash-Lite passed 3
  times, was completed once by the fallback model, and failed 3 times (a provider timeout, an
  iteration limit, and finishing with broken tests; each addressed since). That is not a rate.
  One pass took a design shortcut, registering the command on each app's own CLI group.
- **Small local models** do Task A but not Task B; the 7B model writes wrong edits.
- **The adapter is an extra process** that must be running for Gemini, Groq and OpenRouter.
- **Tested on Windows only**; TrueForge is pinned to 0.185.1, not `@latest`.
- **One flaky automated check** (VS Code's own undo command depends on window focus).

With another month: measure the Task B pass rate over many runs and models; a scout subagent
that reads large files in its own context; a repo-map signal (PageRank over imports) for
retrieval; retrieving an existing test of a similar feature before the agent writes its own;
cross-platform tests; and packaging the adapter's fixes as upstream TrueForge contributions.
