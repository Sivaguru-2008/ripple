# Judge walkthrough

How to run Ripple yourself and check Tasks A, B and C. Every command here is a script in this repository or a standard tool command. Expect about 20 minutes for setup and Task A.

> **Model quality and quotas vary.** Ripple's behaviour (per-hunk review, nothing written before acceptance, undo, clean workspace on cancel or failure, automatic fallback) does not depend on the model. What the model writes does. Task A works on small local models; Task B needs a capable model and 70 to 160 requests per run, and free tiers allow about 3 runs per model per day. Task B passed 3 of 7 attempts on free Gemini Flash-Lite (one more was finished by the fallback model), so a failed Task B run on your model is not unexpected.

## 1. Prerequisites

- Windows, macOS or Linux (only Windows has been tested), with Git and **Node.js 22+**.
- **VS Code 1.95+**.
- **Python 3.10+** with pytest and Flask's dependencies:
  ```powershell
  python -m pip install pytest werkzeug jinja2 click itsdangerous blinker
  ```
- **A model.** The agent definitions use Gemini's free tier by default ([Google AI Studio](https://aistudio.google.com/) key). Any provider TrueForge supports works; see step 3.
- Optional, for the local fallback model in Task C: **[Ollama](https://ollama.com)**.

## 2. Install

```powershell
git clone https://github.com/Sivaguru-2008/ripple.git
cd ripple
npm install
```

Optional sanity check (no model needed): `npm run typecheck`, `npm test` (168 unit tests), `npm run build`.

## 3. Configure a model

Keys go in a git-ignored `.env` at the repository root. Only `scripts/setup-models.mjs` reads it, to register providers in TrueForge; the extension never sees a key.

```powershell
Set-Content -Path ".env" -Value "GEMINI_API_KEY=<your key>"
```

`npm run stack` (step 5) registers every provider in [`config/trueforge.models.example.json`](../config/trueforge.models.example.json) whose key is present, and skips the rest. Names are `<provider>/<model>`, for example `gemini/gemini-3-5-flash-lite`.

**To use another model:**
1. Copy the example to `config/trueforge.models.json` (git-ignored), add your provider (any OpenAI-compatible endpoint, with `"${YOUR_KEY_NAME}"` as the key and the key in `.env`), and run `npm run models`. Or add the provider in the TrueForge UI at http://localhost:8790.
2. Set `model.name` in [`agents/ripple-inline.json`](../agents/ripple-inline.json) (Task A) and [`agents/ripple-agent.json`](../agents/ripple-agent.json) (Task B).

**Local fallback model (Task C):**
```powershell
ollama pull qwen2.5-coder:7b
ollama create qwen2.5-coder-tools:7b -f config/ollama/qwen2.5-coder-tools.Modelfile
```
The Modelfile only changes the chat template so the 7B model returns real tool calls. It is registered as `ollama/qwen-coder-tools-7b`, the default of the VS Code setting `ripple.fallbackModel`.

## 4. Prepare the Flask workspace

```powershell
npm run demo:prepare
```

This clones `pallets/flask` at tag `3.1.3` (commit `22d92470`) with full history into `../flask-demo`, finds a Python that has pytest and Flask's dependencies (it installs nothing), and writes `.env.demo` with `PATH` and `PYTHONPATH=src`, so the agent's `python -m pytest` uses the clone's own Flask.

## 5. Start TrueForge

```powershell
npm run stack
```

Leave this terminal open. It:
- starts TrueForge 0.185.1 in local mode (`npx @truefoundry/trueforge@0.185.1`) with the **localhost allow-list** `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`. Without it, TrueForge refuses to reach Ripple's MCP server on 127.0.0.1;
- starts the model adapter on `127.0.0.1:8794` (needed for Gemini, Groq and OpenRouter);
- registers the model providers, then prints `Ready. TrueForge UI: http://localhost:8790`.

Parts already running are reused. To do the same by hand:
```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'; npx --yes @truefoundry/trueforge@0.185.1
npm run adapter     # second terminal
npm run models      # third terminal, once TrueForge is up
```

## 6. Launch the extension

Open the `ripple` folder in VS Code. In **Run and Debug**, choose **Run Ripple on the Flask demo** and press **F5**. A second VS Code window opens on `../flask-demo` with Ripple loaded. (The first configuration, *Run Ripple*, opens this repository instead.)

In the new window:
- **Ripple** appears in the activity bar: the agent panel with Run Agent, Cancel and Undo Edit buttons, a "Session in TrueForge" link, the Context Receipt, tool calls and a per-file summary of changes.
- **Output → Ripple** shows the log: sessions, tool calls, approvals, reviews, fallback.

## 7. Task A: inline edit

1. Open `src/flask/helpers.py` and select the whole `get_debug_flag` function.
2. Press `Ctrl+;` (macOS `Cmd+Alt+R`) and enter:
   > Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
3. **Look for:** a review tab named `helpers.py (Ripple review …)` with green and red line decorations and an **Accept | Reject** CodeLens above **each** hunk (usually 2: the docstring and the return line). The Output log shows `[review] p1 opened: src/flask/helpers.py, 2 hunk(s)`.
4. Run `git status` in a terminal while the review is open: it is clean, because nothing has been written yet.
5. Accept the hunks. Then verify, in `../flask-demo`:
   ```powershell
   $env:PYTHONPATH="src"; $env:FLASK_DEBUG="off"; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   ```
   Expected: `False`. (bash: `PYTHONPATH=src FLASK_DEBUG=off python -c "..."`.)
6. Run **Ripple: Undo Last Applied Change** (or Undo Edit in the panel). `git status` is clean again.

## 8. Cancel

Start any agent request in the panel and press **Cancel** (or `Ctrl+Alt+Backspace`) while tokens are streaming. **Look for:** "Ripple: cancelled. Staged changes were discarded." and a clean `git status`.

## 9. Task B: agent mode, no files named

1. In the Ripple panel, with no files mentioned, enter:
   > Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
2. **Look for:**
   - **Context Receipt:** budget, tokens used and remaining; each file with its reason (`co-change`, `pairing`, `import`, `lexical`, `pinned`) and evidence such as "changed with src/flask/cli.py in 48 commits"; and the evicted candidates.
   - **Review tabs** opening when the agent proposes a write (TrueForge's approval pause). Accept or reject each hunk; a rejected hunk is reported back to the agent with your reason.
   - **An approval prompt** when the agent wants to run a command such as `python -m pytest tests/test_cli.py -q`.
   - **Changes by file:** the expected set is `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst`.
   - **Session in TrueForge:** opens the session with its turns and tool calls. Compaction events appear in the log when the thread passes 20,000 input tokens.
3. Verify, in `../flask-demo`:
   ```powershell
   $env:PYTHONPATH="src"; python -m pytest tests/test_cli.py -q
   python -m flask --help        # lists "config"
   Set-Content "$env:TEMP\demo_app.py" "from flask import Flask`napp = Flask(__name__)`napp.config['SECRET_KEY'] = 's'`napp.config['API_TOKEN'] = 't'"
   python -m flask --app "$env:TEMP\demo_app.py" config   # SECRET_KEY and API_TOKEN print as "***"
   git diff --stat               # 3 or more files
   ```
4. **Ripple: Undo Last Applied Change** restores all the files in one step; `git status` is clean.

A run takes 5 to 16 minutes on free Flash-Lite. If it fails, the transaction is rolled back and nothing is written.

## 10. Task C: resilience

Make the primary model unreachable, then repeat Task A. Either:
- **Stop the adapter** (the inline agent's Gemini model goes through it). In PowerShell:
  ```powershell
  Stop-Process -Id (Get-NetTCPConnection -State Listen -LocalPort 8794).OwningProcess -Force
  ```
  Restart it afterwards with `npm run adapter`.
- **Or** in the TrueForge UI, point the provider at an unreachable endpoint or give it an invalid key.

**Look for:** the run fails on the primary model, retries, then the Output log shows `[fallback] primary model … failed (…); switching to fallback model ollama/qwen-coder-tools-7b`, and a review opens with the fallback model's edit, with no click from you. A warning says the changes came from the fallback model. `git status` is clean while the review is open, after a reject, and after an undo. The editor stays responsive throughout. Without Ollama running, you get a clear error after the retries instead, and nothing is written.

## 11. Automated checks

The same checks, scripted, in a real VS Code window on a fresh Flask clone each time (about 1 minute each for A and C):

```powershell
$env:VSCODE_EXECUTABLE="<path to Code.exe or the code binary>"
$env:RIPPLE_TEST_PYTHON="<python with pytest>"
$env:RIPPLE_FLASK_REPO="https://github.com/pallets/flask"   # or a local full clone, e.g. the ../flask-demo path
npm run task-a     # Task A on the inline agent's model; fails if the fallback was needed
npm run task-c     # Task C: registers a provider "unreachable" (127.0.0.1:9) as the model
npm run task-b     # Task B, RIPPLE_RUNS times (default 5); about 10 minutes and 100 to 160 requests per run
```

TrueForge must be running (`npm run stack`). `RIPPLE_TEST_MODEL` and `RIPPLE_FALLBACK_MODEL` override the models. Tasks A and C end with `=== TASK A PASSED ===` or `=== TASK C PASSED ===` and the path of a JSON report. Task B checks 3+ files edited, a receipt with co-change evidence, `pytest tests/test_cli.py` passing, `flask --help` listing `config`, masked JSON, and one undo leaving `git status` clean; a run that only passed on the fallback model counts as a failure.

## Evidence

| Date | Check | Result | Source |
|---|---|---|---|
| 16 Nov | Approval allow and deny, cancel | Denied calls never reach the MCP server; cancel ends the turn in 11 to 36 ms with `git status` clean | [AGENTS.md §9 and §11](../AGENTS.md#11-status) |
| 17–18 Nov | Task B on `gemini-3.1-flash-lite` | 3 passes, 1 finished by the fallback model, 3 failures | [write-up §8](writeup.md#8-known-limitations), [AGENTS.md §11](../AGENTS.md#11-status) |
| 18 Nov | `npm run task-a`, `npm run task-c` | Both passed; Task C fallback with longest extension-host stall 186 ms | [AGENTS.md §11](../AGENTS.md#11-status) |
| 18 Nov | Demo recording | Tasks A, B, C as in the [video](https://youtu.be/ZeoBrU6ugYo) | [AGENTS.md §11](../AGENTS.md#11-status) |
| 21 Nov, after submission | Fresh clone of this repository: `npm ci`, typecheck, unit tests, build | All passed; 168 of 168 tests | re-check of the submitted code |
| 21 Nov, after submission | `npm run task-a` from that clone | Passed on `gemini/gemini-3-5-flash-lite` in 3.3 s, no fallback; 2 hunks; `off`, `n`, `OFF` false and `1` true; docstring lists every false value; longest stall 137 ms; `git status` clean during review and after undo | re-check of the submitted code |
| 21 Nov, after submission | `npm run task-c` from that clone | Passed: unreachable primary, then `ollama/qwen-coder-tools-7b` with no user action in 13.8 s; same checks; longest stall 235 ms | re-check of the submitted code |

Task B was not re-run after submission.

## Troubleshooting (Windows)

| Symptom | Cause | Fix |
|---|---|---|
| `127.0.0.1:8790` refused | TrueForge listens on `[::1]` only on Windows | Use `http://localhost:8790` (the default of `ripple.trueforgeBaseUrl`) |
| `Outbound URL blocked for host "127.0.0.1"` (HTTP 400) when Ripple registers its MCP server | TrueForge started without the localhost allow-list | Start it with `npm run stack`, or set `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'` as in step 5 |
| `ECONNREFUSED 127.0.0.1:8794` | Model adapter not running | `npm run stack` or `npm run adapter` |
| `'trueforge' is not recognized` when the stack starts | Damaged npx cache (seen after a full disk) | `Remove-Item -Recurse -Force "$env:LOCALAPPDATA\npm-cache\_npx"`, then `npm run stack` |
| `Ctrl+;` does nothing | The binding needs editor focus and a selection | Select the code first. (Ripple avoids `Ctrl+Alt+<letter>`: on Windows that is AltGr and can type a character into the selection.) |
| HTTP 429 or "You exceeded your current quota" | Free daily quota of that model | Ripple switches to `ripple.fallbackModel`; Gemini quotas are per model and reset at midnight Pacific time |
| HTTP 503 "high demand" | Provider overload | The adapter retries for up to 150 s; then Ripple retries once and falls back |
| `Headers Timeout Error` on the first request | A cold local model took over 60 s to load | Ripple sends a warm-up turn on activation (`ripple.warmUp`); try again once it has loaded |
| The agent runs `pip install` or pytest cannot import Flask | `python` on `PATH` lacks pytest, or imports another Flask | Use the **Run Ripple on the Flask demo** configuration (it applies `.env.demo`); re-run `npm run demo:prepare` |
| The Extension Development Host stalls downloading a .NET SDK | The C# extensions activate in the dev host | Both launch configurations already disable `ms-dotnettools.csharp` and `ms-dotnettools.csdevkit` |

More, including every bottleneck seen during development: [runbook.md](runbook.md).
