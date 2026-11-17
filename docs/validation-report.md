# Ripple validation report (16-17 Nov 2026)

Everything below was run, not inferred. Where a step could not be run, it says so.

## Verdict

| Phase | Result |
|---|---|
| Phase 1: Task B, 5 runs with a strong hosted model | **Not achieved: 0 of 5.** Blocked by provider rate limits on both keys, not by Ripple (details below). No full Task B run has completed on a hosted model yet. |
| Phase 2: independent verification at `963d790` | **Passed** for typecheck, unit tests, Task A on the local 7B model (3 of 3) and Task B on the scripted mock. Task B on the 7B model fails (3 of 3), as before. |
| Task C: resilience | 6 of 6 unit tests pass. Fallback was also seen live four times during Phase 1 (hosted model failed, the 7B model took over with no user action, nothing was written). |

## Setup

- Ripple `master` at `963d790` (Task C: `70e45f9`; Gemini agent config: `930bfec`; adaptive budget: `1013e87`).
- TrueForge `0.185.1` on `http://localhost:8790`, SDK `0.185.0`.
- VS Code: the installed build, launched with a fresh user-data directory per run.
- Repository under test: `pallets/flask` at `3.1.3` (`22d92470`), fresh clone per run.
- Phase 1 used the builder tree (`E:\ripples`) because it needs two uncommitted changes:
  `large_tool_response` disabled in `agents/ripple-agent.json`, and the harness in
  `test/integration/`. Phase 2 used the detached worktree `E:\ripple-verify`.

## Phase 1: Task B with a hosted model

| # | Model | Outcome | Cause |
|---|---|---|---|
| 1 | `gemini/gemini-3-flash-preview` | Failed, 0 files | HTTP 429 after 3 successful model calls: free tier allows 20 requests per day for this model. Fell back to the 7B model, which ended the turn without edits. |
| 2 | `groq/gpt-oss-120b` | Failed, 0 files | HTTP 400 on the second request: Groq rejects the `reasoning_content` field TrueForge sends back. Fell back to 7B. |
| 3 | `groq/gpt-oss-120b` | Failed, 0 files | Same as run 2 (repeated with run tracing added to the harness). |
| 4 | `groq/gpt-oss-120b` (through the adapter) | Failed, 0 files | 5 model calls succeeded, then HTTP 429: the key is on Groq's `on_demand` tier, 8,000 tokens per minute. Retried once, then fell back to 7B. |

These were single smoke runs; the 5-run set was not started because no run could pass.

Why this cannot be fixed on our side:

- **Gemini free tier:** 20 requests per day. One Task B run needs more than that.
- **Groq on-demand tier:** 8,000 tokens per minute for `gpt-oss-120b`, `gpt-oss-20b` and
  `qwen3.8-27b` (read from the `x-ratelimit-limit-tokens` header). The context budget for
  `retrieve_context` alone is 8,000 tokens and `src/flask/cli.py` is larger than that, so a single
  request exceeds the per-minute allowance.

What did get verified in Phase 1:

- The thought-signature adapter works with streamed responses. In run 1 the signatures were captured
  and re-attached on three follow-up requests and the earlier
  `Function call is missing a thought_signature` 400 did not occur.
- Dropping `reasoning_content` in the adapter fixes the Groq 400 (run 4 made 5 calls).
- In all four runs the editor stayed up, fallback happened without user action, and `git status`
  stayed clean.

Observation from run 4: `gpt-oss-120b` spent its five calls on `list_tools` through `call_tool`
with slightly different arguments and never reached `retrieve_context`. Too few calls to judge, but
the deferred-tool flow may need a clearer prompt for this model.

### Local model with a larger window (17 Nov, builder tree, uncommitted)

Ollama was loading `qwen2.5-coder-tools:7b` with a 4,096-token window. A variant with
`num_ctx 16384` (`ollama/qwen-coder-tools-7b-16k`, 5.5 GB, fully on an 8 GB GPU) was tried on Task B.

| Run | Change under test | Outcome |
|---|---|---|
| 1 | 16K window only | No edits. Looped on `list_tools`. |
| 2 | Same, with tool responses traced | No edits. Retrieval (8,000 tokens) plus a whole `cli.py` read overflowed the window. |
| 3 | Retrieval capped at 30% of the window (4,915); `read_file` capped at 250 lines per call | No edits. The model paged through `cli.py` as told, then stopped. |
| 4 | Plus one follow-up turn asking for `propose_write` | No edits. The model answered in text. |

Result: 0 of 4. The three changes fix real context overflows and are kept (the mock suite and unit
tests pass with them), but a 7B model still does not carry out Task B. A hosted model with a real
token allowance is still needed. OpenRouter's free tier (50 requests per day) was checked but not
used.

### Shrinking what each step sends (17 Nov, builder tree, uncommitted)

Every step resends the whole conversation, so anything large that enters it is paid for again
on every later step. The adapter now logs the size of each request, so these are measured.

Changes:

1. **Retrieval as a map** (`ripple.retrievalStyle`, default `map`). `retrieve_context` sends the
   receipt plus, per file, its definitions or doc sections with line ranges and the most relevant
   line ranges; files under 500 tokens are still sent whole, pinned ranges are still sent as text,
   and the map lists at most 6 unpinned files (the rest appear as evicted). On the flask Task B
   request: **2,038 tokens for 6 files, against 4,655 for 5 files as excerpts**, same budget.
2. **All tools preloaded** in `agents/ripple-agent.json` (`preload: true`). Both Groq and the local
   model had spent 2 to 10 steps on `list_tools` / `get_tool_info` / `call_tool`; those are gone.
   This retires deferred tools as the showcased context-engineering feature; the budgeted map with
   its receipt takes that role.
3. **Smaller replies:** `read_file` returns at most 120 lines per call; `run_command` output is
   capped at 2,400 characters (start and end kept).
4. **Instructions** tell the agent to read only the ranges from the map and to finish one file
   (read, then `propose_write`) before the next.

Measured, local `qwen-coder-tools-7b-16k`, Task B, prompt tokens per request:

| Request | Before (map off, deferred tools) | After |
|---|---|---|
| 1 | 1,188 | 1,239 |
| 2 | 4,276 | 4,327 |
| 3 | 6,897 | 5,900 |
| 4 | 9,836 | 5,966 |
| 5 | 12,675 (TrueForge compacted the history here) | 6,203 |
| 6 | | 7,478 |
| 7 | | 8,765 |

Behaviour changed as intended: the model read `src/flask/cli.py` lines 531-696 (`FlaskGroup`)
straight from the map instead of paging from line 1, and for the first time called `propose_write`.
Its edit was wrong (empty `old_text` on an existing file, rejected by the transaction layer with a
clear message), and the run then ended on a 60-second `Headers Timeout` from the local model, then
from the fallback model (switching Ollama models on an 8 GB GPU forces a slow reload). **Task B on
the 7B model: still 0 passes.** Task A and cancel on the 7B model still pass after the changes
(2 hunks, `FLASK_DEBUG=off` prints `False`, cancel in 24 ms).

Other findings:

- **TrueForge compacts on its own.** Near the window limit it emitted
  `thread.context_compaction_started` / `finished` and continued with a summary. Idea "drop old
  tool results" therefore needs no code of ours.
- **Groq does not discount cached tokens on this tier.** The same 4,124-token prompt was charged in
  full three times and the third call hit 429. With the changes a strong model's requests should
  stay near 5,000 to 9,000 tokens, which is still at or over Groq's 8,000 per minute: Groq stays
  usable for Task A only.
- **Old test clones lose `.git/refs`.** All `ripple-b-*` clones in `%TEMP%`, including passing runs
  from 16 Nov, later lose their empty `refs` folders and stop being git repositories. Something
  outside Ripple removes empty folders from the temp directory. Fresh clones are fine; it does not
  affect a run in progress, but `git status` checks must be made during the run, as the harness does.

Tests: 114 of 114 unit tests (4 new for the map, 3 for paging); full mock suite passes in a VS Code
host with all tools preloaded.

### First Task B run on a strong model (17 Nov, OpenRouter free tier)

Model: `openrouter/nemotron-3-ultra` = `nvidia/nemotron-3-ultra-550b-a55b:free` ($0 per request;
the key has no credits), through the adapter. One run, 268 s, ended by OpenRouter's free daily
limit (`free-models-per-day`, 50 requests).

What the agent did on its own, no files named:

- `retrieve_context`, then read ranges of `src/flask/cli.py` (including 531-696, `FlaskGroup`),
  `src/flask/config.py`, `tests/test_cli.py` and `docs/cli.rst`.
- Staged and got accepted 4 hunks: an import, the `config` command and its registration in
  `FlaskGroup` in `src/flask/cli.py`, and a test in `tests/test_cli.py`.
- Three `old_text` misses on `cli.py` before getting one right; it worked around them with
  `run_command` (two failed because it used Unix commands on Windows).
- The `docs/cli.rst` edit never arrived: the model sent `edits` as a JSON-encoded string, the
  schema rejected it without a message the model could use, and it repeated the identical call 16
  times until the daily limit was reached.
- The run ended in error; the hunks already written for `run_command` were rolled back and the
  clone's `git status` was clean.

Requests: 52; prompt size grew from 1,687 to 37,149 tokens (OpenRouter's count). The 16 repeated
calls account for about a third.

Fixes made after the run:

- `propose_write` accepts `edits` as a JSON-encoded string as well as a list, and returns a usable
  message when it is neither.
- An `old_text` that matches the file except for indentation or trailing spaces is accepted when the
  match is unique and the indentation is off by one consistent amount; `new_text` is shifted by the
  same amount. Otherwise the error now says on which line the first line of `old_text` occurs and
  which range to re-read.

Tests: 123 of 123 unit tests (9 new); full mock suite passes.

Implication: on the free tier a Task B run needs most of a day's 50 requests, so about one run per
day. That is not enough for 5 runs, or the Thursday 8 of 10, before Friday. A provider with a
larger allowance (Mistral free tier, or OpenRouter after a one-off $10 of credits, which raises
the free-model limit to 1,000 requests a day) is needed for the full count.

### Gemini models on the existing free key (17 Nov, evening)

Mistral's free tier is no longer offered. The AI Studio key has a separate free daily quota per
model; only `gemini-3-flash-preview` was used up. One tool-call probe each: `gemini-3.5-flash`,
`gemini-3.5-flash-lite` and `gemini-3.1-flash-lite` answered with correct tool calls and thought
signatures; `gemini-2.5-*` are closed to new users; `gemini-3.7-flash` and `gemini-3.8-flash`, and
from 19:00 also `gemini-3.5-flash`, returned 503 "high demand".

- `gemini-3.5-flash`, Task B: 503, then no response headers within 60 s; Ripple retried once,
  then switched to the local fallback, which wrote nothing; the run reported that honestly.
- `gemini-3.1-flash-lite`, Task B: found `cli.py`, read `routes_command` and `FlaskGroup` from the
  map, and got 7 hunks accepted in `cli.py` (one `old_text` miss, fixed by the new line hint). Then
  it ran `pip install -e .` through `run_command`, which the harness approved because it approved
  every command, ran `pytest` without `PYTHONPATH`, and resent one identical, already-applied
  `tests/test_cli.py` edit for over 90 requests. Stopped by hand; the session was cancelled.

**Side effect on this machine:** that `pip install -e .` ran with the `pip` on PATH, Python 3.10.
Python 3.10's Flask is now an editable install of the temporary clone
`%TEMP%\ripple-b-1-x4UDIq\flask` (changed 17 Nov 18:57). Python 3.12, which the tests use, was not
touched. Repaired the same evening: the editable install was uninstalled and Flask 3.1.3 installed
from PyPI; `import flask` in Python 3.10 now loads from its `site-packages`.

Fixes:

- The harness and the mock suite now use `approveCommands: 'tests-only'`: only a plain
  `pytest ...` or `<python> -m pytest ...`, optionally after one `PYTHONPATH` assignment, is
  approved; anything chained, piped, redirected, or any install is denied with a reason.
- A repeated identical edit now gets a reply that says, from the second repeat, that it is done and
  must not be proposed again.
- The adapter retries 503, 500 and per-minute 429 for up to 40 s (not daily quotas).

Tests: 139 of 139 unit tests (16 new); full mock suite passes with test-only approval.

### Compaction as the TrueForge context-engineering feature (17 Nov, night)

The brief's top B4 anchor names TrueForge's own features (subagents, deferred tool loading, Code
Mode, compaction, skills). Deferred tool loading was switched off earlier (models looped on
`list_tools`), and the retrieval map counts under B1, not B4. Compaction now fills that role:

- `agents/ripple-agent.json`: `context_management.compaction` enabled with an `input_tokens`
  trigger at 12,000. TrueForge's default is 80% of the model's window, which for a 1M-token model
  never fires; at 12,000 a Task B run (which reached 37,000 tokens on OpenRouter) is compacted
  about every ten steps, which also keeps each request small for free-tier limits.
- Ripple handles `thread.context_compaction_started` / `finished`: logged with the context size,
  threshold, duration and summary size, and shown in the agent panel's status line.
- Verified on the local 16K model with a test-only threshold of 2,500
  (`RIPPLE_TEST_COMPACTION_TOKENS` in the Task B harness): `contextTokens=3376 threshold=2500`,
  compacted in 16,633 ms to a 706-token summary, then compacted again later in the run. Not yet
  seen at the real 12,000 threshold (no hosted model was available; Gemini Flash was overloaded).

Tests: 139 of 139 unit tests; the agent-spec test now checks the compaction setting.

## Phase 2: independent verification (`E:\ripple-verify`, `963d790`)

| Check | Result |
|---|---|
| `npm run typecheck` | Clean |
| `npm test` | 100 of 100 tests, 12 files |
| Task A, `ollama/qwen-coder-tools-7b`, run 1 | Pass. 2 hunks reviewed and applied; `FLASK_DEBUG=off` prints `False` (`n` and `OFF` too, `1` prints `True`). Cancel ended the run 27 ms after the request. |
| Task A, same model, run 2 | Pass. Same 2 hunks. Cancel in 35 ms. |
| Task A, same model, run 3 | Pass. Same 2 hunks. Cancel in 16 ms. |
| Task B, same model (3 runs) | **Fail** each time: `You have reached iteration limit of 25`. |
| Full suite, scripted mock | Pass. Task B edits `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`; `59 passed`; undo leaves `git status` clean. The mock's edits are scripted. |

Note: run 3 and the mock run were each started twice by mistake and overlapped on the same
TrueForge. Both copies gave the same result; the surviving log is one of the two.

The 7B model now produces both hunks for Task A (code and docstring). The status table in
`AGENTS.md` still says it produces one.

## Task C: resilience tests (`test/resilience.test.ts`, 6 of 6)

1. Primary model timeout, recovery on the fallback model.
2. Primary model connection failure (bad port), recovery on the fallback model.
3. Invalid tool-call response, recovery without applying stale edits.
4. Fallback model also fails: clean error, workspace unchanged.
5. Cancel during the switch to the fallback model: workspace clean.
6. End-to-end recovery keeps the run and transaction identity.

These use a scripted client. Task C has not yet been run as written in section 7 (unreachable
endpoint, then Task A, in a VS Code host).

## Scorecard (what the evidence supports today)

| Criterion | State |
|---|---|
| A1 Inline edit | Verified in a VS Code host, mock and local 7B (3 of 3). Not yet clicked by hand. |
| A2 Agent mode, 3+ files unprompted | **Unproven.** Passes only with the scripted mock. |
| A3 Streaming and cancel | Verified: cancel in 16 to 35 ms, `git status` clean. |
| B1 Context | Receipt with co-change evidence verified in the mock run. Not seen with a real model. |
| B2 Diff safety | Per-hunk review and one-step undo verified (mock and 7B). |
| B3 Resilience | Unit tests pass; live fallback seen four times. Section 7 Task C not yet run. |
| B4 Integration | MCP tools, approval-driven review and deferred tools verified with the mock. |
| C1 Video, C2 Write-up | Not started. |

## Limitations and risks

- **No strong model is usable right now.** Task B "8 of 10" (Thursday gate) needs a key with real
  quota: a billed Gemini key, Groq Dev tier, or any other provider TrueForge supports.
- **Fixed (17 Nov, uncommitted): a failed-over run used to report `done` with nothing changed.**
  The run result now carries the model that finished, the fallback switch (from, to, reason) and
  the number of hunks written, and the user gets a warning when a run ends without edits or on the
  fallback model. Seen in a VS Code host: `groq/gpt-oss-120b failed (… 413 Request too large …
  Limit 8000, Requested 9881); ollama/qwen-coder-tools-7b took over and finished without changing
  any file. The task was not carried out.` The Task B harness now fails a run that finished on the
  fallback model. Unit tests: 102 of 102.
- **Retries on quota errors waste quota.** A daily-quota 429 is retried like a transient one.
- **The adapter is an extra moving part.** `scripts/gemini-proxy.mjs` must be running for the
  `gemini` and `groq` providers as now configured in TrueForge. It is a model endpoint configured
  in TrueForge; the extension never calls it, so rule 3 holds. It needs a README entry.
- **Key hygiene.** `test/scratch_gemini.mjs` and `test/scratch_update_provider.mjs` contain an API
  key in plain text. They are untracked, the key is not in git history, and `test/scratch_*` is now
  in `.gitignore`. The Groq key is in the gitignored `.env`. Delete the scratch files before the
  repo goes public.
- `E:\ripples` has uncommitted work: `.gitignore`, `agents/ripple-agent.json`,
  `scripts/gemini-proxy.mjs`, `test/integration/runTaskBEval.mjs`, `test/integration/taskBSuite.ts`,
  and this report.
