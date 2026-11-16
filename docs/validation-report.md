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
