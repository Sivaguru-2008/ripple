# Runbook: running Ripple's agent reliably

Everything here was learned from failed and passing Task B runs between 16 and 17 Nov 2026
(details in `docs/validation-report.md`). Follow it in order and the known bottlenecks do not
come back.

## One-time setup

1. `npm install`
2. **Keys** go in `.env` at the repository root (git-ignored, never committed):

   ```
   GEMINI_API_KEY=...        # aistudio.google.com, free tier; this is what passed Task B
   OPENROUTER_API_KEY=...    # optional: openrouter.ai, free ":free" models, 50 requests a day
   GROQ_API_KEY=...          # optional: Task A only (8,000 tokens per minute on the free tier)
   ```

   A provider whose key is missing is simply skipped.
3. **Demo workspace:** `npm run demo:prepare`. It clones pallets/flask at 3.1.3 into
   `../flask-demo` (from `../forge-refs/flask` if present, else GitHub), finds a Python that has
   pytest and Flask's dependencies, and writes `.env.demo` (git-ignored) with `PATH` and
   `PYTHONPATH=src`. It installs nothing. If no suitable Python is found it says what to install.
4. Optional local fallback: Ollama with `qwen2.5-coder-tools:7b` (see AGENTS.md section 9).

## Every session

1. `npm run stack` and leave that terminal open. It starts TrueForge 0.185.1 with the
   loopback allow-list, the model adapter on `127.0.0.1:8794`, and registers every provider
   from `config/trueforge.models.example.json` (or your `config/trueforge.models.json`).
   Parts already running are reused. TrueForge UI: http://localhost:8790.
2. In VS Code (this repository), run the launch configuration **Run Ripple on the Flask demo**.
   It opens `../flask-demo` with `.env.demo` applied.
3. In that window's settings, set `ripple.fallbackModel` to `gemini/gemini-3-5-flash-lite`
   (a second free quota) unless you want the local model.

The agent uses `gemini/gemini-3-1-flash-lite` (set in `agents/ripple-agent.json`).

## Automated check of Task B

```powershell
$env:VSCODE_EXECUTABLE="<path to Code.exe>"
$env:RIPPLE_TEST_PYTHON="<python with pytest>"
npm run task-b
```

`RIPPLE_TEST_MODEL` and `RIPPLE_FALLBACK_MODEL` override the models; `RIPPLE_RUNS` sets the
number of runs (pass mark 80%). Each run uses a fresh clone and checks: 3+ files edited, receipt
with co-change evidence, `pytest tests/test_cli.py` passing, `flask --help` listing `config`,
masked JSON, and one undo leaving `git status` clean. A run that only passed on the fallback
model counts as a failure.

Expect about 10 minutes and 100 to 160 requests on Flash-Lite.

## Tasks A and C

The inline agent (`agents/ripple-inline.json`) uses `gemini/gemini-3-5-flash-lite`; the fallback
(`ripple.fallbackModel`, default `ollama/qwen-coder-tools-7b`) talks to Ollama directly, not
through the adapter, so it keeps working when Gemini is unreachable. Ollama must be running.

Automated checks (each on a fresh clone, in a real VS Code host, about 1 minute):

```powershell
npm run task-a     # Task A on the inline agent's model; fails if the fallback was needed
npm run task-c     # Task C: TrueForge provider "unreachable" (127.0.0.1:9) as the model
```

Both check: one review with per-hunk hunks, `git status` clean while it is open,
`FLASK_DEBUG=off`, `n`, `OFF` false and `1` true after accepting, the docstring lists every
false value, the longest extension-host stall under 1 s, and one undo leaving `git status` clean.
Task C also checks that the fallback model took over with no user action.

For the video, Task C by hand: stop the adapter (Ctrl+C in the `npm run stack` terminal, or
`npm run stack` without it), so Gemini is unreachable; repeat Task A. Ripple retries once, then
shows "gemini/gemini-3-5-flash-lite failed (Cannot connect to API...); ollama/qwen-coder-tools-7b
took over"; run `git status` while the review is open (clean), accept, verify, undo.

## Recording the demo video

`npm run demo:record` makes the submission video by itself: a fresh flask 3.1.3 clone, the real
VS Code with Ripple driven through Tasks A, B and C by `scripts/demo/demoSuite.ts`, a full-screen
capture with ffmpeg, then `scripts/demo/make-video.mjs` edits it into `demo-out/<time>/ripple-demo.mp4`
with captions, a Windows text-to-speech voice-over, a title card and a summary card, model waiting
time played faster (labelled on screen, never cut), under 4 minutes, and `scorecard.md` with the
video timestamp of each scoring moment for the write-up.

1. `npm run stack` running, Ollama running, Gemini quota fresh (after 13:30 IST).
2. Set `VSCODE_EXECUTABLE` and `RIPPLE_TEST_PYTHON` as for `npm run task-b`.
3. `npm run demo:record` (or `-- --mock` to check the pipeline with the scripted model, no quota).
4. **Do not touch the computer until it prints "Recording stopped"** (about 5 minutes with the mock,
   10 to 20 with real models). It minimizes every window, keeps the demo VS Code window maximized
   in front, crops the taskbar out, and restores the windows at the end; anything opened meanwhile
   would still cover VS Code.
5. Watch the result before uploading. Task B does not succeed every time; record again if needed
   (about 100 Gemini requests per take).

The video says, on the title card, that clicks and typing are automated and the models, edits,
tests and results are real. The TrueForge session is shown in VS Code's built-in Simple Browser,
never the system browser. `demo-out/` is git-ignored.

## Bottlenecks seen, and what now prevents them

| Seen | Cause | Now |
|---|---|---|
| Request rejected, "Limit 8000, Requested 9881" (Groq) | free tier tokens per minute below one request | use Gemini or OpenRouter for Task B; Groq for Task A only |
| HTTP 429 after 20 requests (gemini-3-flash-preview) | that model's free daily quota | agent uses `gemini-3.1-flash-lite`; every Gemini model has its own quota |
| HTTP 503 "high demand" | Google overload | adapter retries for up to 150 s inside an open stream; then Ripple retries once and falls back to the second model |
| `Headers Timeout Error` after 60 s, mid-run | TrueForge waits at most 60 s for response headers; a slow provider took longer | the adapter answers streamed requests at once and sends a keep-alive every 10 s (checked: a 75 s answer now completes) |
| HTTP 429 "You exceeded your current quota" mid-run | that model's free daily quota (about 400 to 500 requests on Flash-Lite on 17 Nov) | no retry on the same model: straight to the fallback model, keeping the accepted edits (seen: the fallback finished the task, every check passed) |
| Run thrown away after a model error, though edits were accepted | Ripple rolled back and stopped once edits were on disk | an interrupted agent run keeps its accepted edits; the retry or fallback model is told what is done and continues; only if every attempt fails is everything rolled back |
| `thought_signature` missing (Gemini) | TrueForge drops a Gemini-only field | adapter re-attaches it, streamed or not |
| `reasoning_content` unsupported (Groq) | TrueForge echoes reasoning | adapter removes it |
| 2 to 10 steps on `list_tools` | deferred tool loading | all tools preloaded |
| Whole-file reads, context overflow | large tool results resent every step | retrieval map, `read_file` capped at 120 lines, TrueForge compaction at 20,000 tokens |
| Agent redoes edits after compaction | the summary keeps the plan, not the edits | `retrieve_context` starts with "Changes already made in this run" |
| `old_text was not found` | copy errors | insert edits (`insert_after_line` + checked `line_text`); indentation-tolerant matching; the error names the line |
| `edits` sent as a JSON string, 16 times | model formatting | decoded |
| Same applied edit resent 90 times | model loop | from the second repeat the reply says to stop |
| `pip install -e .` | pytest could not import Flask | `.env.demo` / harness environment; the harness approves only test commands |
| `cat`, `findstr` failing | Unix commands on Windows, used to read files | instructions: `run_command` only for tests |
| OpenRouter 401 "User not found" | key disabled | check with the provider; `npm run models` re-registers |
| `ECONNREFUSED 127.0.0.1:8794` | adapter not running | `npm run stack` |
| `127.0.0.1:8790` refused (Windows) | TrueForge listens on `::1` | use `http://localhost:8790` |

## Daily request budget

A Task B run takes 70 to 160 model requests. Each Gemini model has its own free daily quota,
reset at midnight Pacific time (13:30 IST); Flash-Lite ran out after about 400 to 500 requests
on 17 Nov. So plan about 3 full runs per model per day, keep the fallback on a different
Gemini model, and do not spend the quota on rehearsal runs the day of recording. OpenRouter's
free models share 50 requests a day per account (reset 05:30 IST).

The automated check reports a run that the fallback finished as "passed every check, but only
after falling back"; it is recorded with `finishedOn` and `fallback` in the run report and does
not count as a pass for the primary model.

## Known flaky check

`npm run test:vscode`, step "Task A: accept all hunks", uses VS Code's own `undo` command on the
editor. If the test window is not in front it can fail with "one undo did not restore the
original text" although the edit was right; it passed on the rerun each time (17 Nov).

## Quick checks when something is off

- `npm run models`: are the providers registered? (prints each `provider/model`)
- http://127.0.0.1:8794/health: is the adapter up?
- The adapter's terminal lines show every model request: status, size and token usage.
- The Ripple output channel shows the run trace, retries, fallback and compaction.
