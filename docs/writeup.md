# Ripple: an editor-native coding agent on TrueForge

Round 1 Submission Write-up · TrueFoundry Forge-a-thon (Techfest IIT Bombay 2026–27) · submitted 20 Nov 2026, updated 22 Nov 2026

## 1. Team

Sivaguru Murugan, solo. GitHub: @Sivaguru-2008.

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
  action, in a new TrueForge session on the same edit transaction. An interrupted agent run keeps
  the edits the user already accepted, and the new session is told which changes are already made; if every attempt fails, everything is rolled back. An agent that ends its
  turn while its own last test run failed is sent the failure and asked to fix it (at most
  twice) before the run may finish.

**Design decisions, and what each one costs.**

- **Ranking without embeddings.** Git co-change, test and doc pairing and BM25 each give a reason a
  person can check ("changed with `cli.py` in 48 commits"), which is what the receipt shows; an
  embedding score cannot be explained, and needs an index. Cost: a file related only in meaning,
  with no shared history, name or words, is missed.
- **A map instead of file text.** Outlines with line ranges let the agent read only the ranges it
  needs, so 6 files fit in 2,038 tokens and the thread stays small for small models. Cost: more
  `read_file` round trips, which matters on rate-limited free tiers.
- **TrueForge approval as the review.** The diff review is driven by the turn's own approval pause,
  not a side channel, so the session records every decision and a denied write never reaches the
  MCP server. Cost: the turn stays open while the user reviews.
- **One write per run.** Accepted hunks are held and written as one `WorkspaceEdit`, so a cancel
  leaves nothing half-applied and one undo restores every file. Cost: the agent's tests need the
  files on disk, so accepted edits are written just before a test command runs.
- **Fallback in the extension, not the proxy.** TrueForge has no built-in failover, so Ripple
  opens a new session with the second model on the same edit transaction and tells it which
  accepted changes are already made; this works for any provider, including Ollama, which bypasses
  the proxy. Cost: the new session starts without the failed thread's history, and the fallback
  is usually a weaker model (the local 7B does Task A but not Task B).

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
| `gemini/gemini-3-1-flash-lite` | Google AI Studio, free tier | agent mode (Task B) | $0 |
| `gemini/gemini-3-5-flash-lite` | Google AI Studio, free tier | inline edits (Task A); agent fallback | $0 |
| `ollama/qwen-coder-tools-7b` (qwen2.5-coder 7B, tool-call template) | Ollama on the laptop (RTX 5050, 8 GB) | inline fallback (Task C) | $0 |
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
| A1 Inline edit | 00:32 | Task A diff in the editor: 2 hunks, each with its own Accept / Reject (a reject is used at 03:42) |
| A2 Agent mode | 02:04 | Task B (prompt at 01:24, no files named): the agent found and edited `cli.py`, `test_cli.py` and `cli.rst` |
| A3 Streaming and cancel | 01:08 | Tokens stream; cancel at 01:13 ends the run (16 to 35 ms in tests) with `git status` clean |
| B1 Context assembly | 01:28 | Budgeted map retrieval; the receipt shows each file, why it was chosen, tokens and evictions |
| B2 Diff safety | 00:32 | Nothing reaches disk before acceptance; one undo restores the file (01:00) and all three Task B files (02:58) |
| B3 Resilience | 03:16 | Task C: Gemini endpoint stopped (03:06), retry, then the local model takes over with no user action; `git status` clean with the review open (03:38) and after reject (03:44) |
| B4 TrueForge depth | 01:50 | MCP tools; the approval pause opens the review; compaction starts (01:50); TrueForge session with all tool calls and the compaction step (02:18, from a 22 Nov rerun of Task B on the same model) |
| C1 Video | 00:00 | Tasks A (00:20), B (01:18), C (03:02) in order, each verified on screen: `FLASK_DEBUG=off` prints False (00:50), pytest passes (02:30), masked JSON (02:42); 3m 56s |
| C2 Write-up | n/a | This document (1 to 3 pages) |

Automated evidence (`docs/validation-report.md`): Task A and Task C pass in a real VS Code host on
fresh clones (`npm run task-a`, `npm run task-c`); Task B (`npm run task-b`) passed four times on
`gemini/gemini-3-1-flash-lite` (59 tests passed, `flask --help` lists `config`, masked JSON, undo
clean), was completed once by the fallback after the primary's daily quota ran out mid-run, and
failed four times (section 8); 168 unit tests.

## 7. Tools used

Claude Code (Anthropic), Antigravity (Google DeepMind) and Codex (OpenAI) for implementation, testing, and documentation; VS Code, Node.js 24, Ollama, Python 3.12, pytest.

## 8. Known limitations

- **Slow and request-hungry on free models.** A Task B run takes 5 to 16 minutes and 70 to 160
  model requests; free daily quotas allow about 3 runs per model per day.
- **Pass rate not established.** Over 17 and 18 Nov, Task B on free Gemini Flash-Lite passed 3
  times, was completed once by the fallback model, and failed 3 times (a provider timeout, an
  iteration limit, and finishing with broken tests; each addressed since). On 22 Nov, rerun to
  film the TrueForge session, it failed once (broke 4 existing route tests) and then passed.
  Four passes in nine runs is not a rate, and one pass took a design shortcut (registering the
  command on each app's own CLI group).
- **Small local models** do Task A but not Task B; the 7B model writes wrong edits.
- **The proxy (`scripts/gemini-proxy.mjs`) is an extra process** that must be running for Gemini, Groq and OpenRouter.
- **Tested on Windows only**; TrueForge is pinned to 0.185.1, not `@latest`.
- **One flaky automated check** (VS Code's own undo command depends on window focus).

With another month: measure the Task B pass rate over many runs and models; a scout subagent
that reads large files in its own context; a repo-map signal (PageRank over imports) for
retrieval; retrieving an existing test of a similar feature before the agent writes its own;
cross-platform tests; and packaging the proxy's fixes as upstream TrueForge contributions.
