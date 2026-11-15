# Day 1 verification (16 Nov 2026)

Evidence for AGENTS.md section 9 and the Monday gate. Everything below was observed in a
run, not read from docs, unless marked otherwise.

Setup: TrueForge `0.185.1` (`npx @truefoundry/trueforge@0.185.1`, isolated SQLite),
SDK `@truefoundry/trueforge-sdk 0.185.0`, MCP SDK `1.32.2`, VS Code 1.142, Windows 11.
Model: a scripted OpenAI-compatible mock (`test/integration/mock-model.mjs`) configured in
TrueForge as provider `ripple-mock`. Runs: `npm run test:vscode` (real Extension
Development Host) and headless scripts using the same `src/` modules.

| Question | Result | How it was shown |
|---|---|---|
| Approval pause and resume | Works. `tool.approval_required` → `turn.update status=paused`; `subscribeToTurn(afterEventId)` then `createTurnEvents` with `user.tool_approval` resumes the same turn to `turn.done status=done`. | `npm run test:vscode`, allow and deny |
| Deny | The call never reaches the MCP server; the model gets `tool.response` `User denied tool call: <reason>`; turn ends `done`. | same |
| MCP registration | `settings.mcpServers.createOrUpdate` with `type: 'remote'` and header auth; `mcp.initialize servers=[ripple:streamable-http]`. | same |
| Localhost allowlist | Without `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`, registration fails: HTTP 400 `Outbound URL blocked for host "127.0.0.1"`. With it, all works. The variable is not in the docs; found in the shipped server code. | second TrueForge on port 8793 without the variable |
| TrueForge listen address | On Windows it binds `[::1]` only; `127.0.0.1:8790` is refused. Use `http://localhost:8790`. | netstat, curl |
| Per-tool approval | `require_approval_for_tools: ["propose_write"]` pauses `propose_write`, not `read_file`. | integration test |
| Model fallback | No native failover. Unreachable model → `turn.done status=error` `[Model Error] Cannot connect to API: bad port` in 126 ms. `sessions.update(id, { agent: { spec } })` with another model, then a new turn on the same session → `done` on the new model. | headless script |
| Cold local model | Ollama loading a 7B model: `[Model Error] Cannot connect to API: Headers Timeout Error` after about 60 s. Fallback must treat this as a failure too. | headless script |
| Cancel (paused turn) | `sessions.cancel` → turn state `cancelled` (reason starting `client-cancell…`). A late `createTurnEvents` gets HTTP 409 `Turn is not accepting events`; nothing ran. `runTurn` does not yet handle that 409. Cancel of a running turn not yet tested. | headless script |
| Token deltas | `model.message.delta`; tool calls also arrive only in deltas and must be merged into the base `model.message` (`mergeEventDelta`). | all runs |

## Real local model

`RIPPLE_TEST_MODEL=ollama/qwen-coder-tools-7b npm run test:vscode` passed (allow and deny,
README unchanged), in a real VS Code host, against a local 7B model on Ollama 0.40.16.

Getting there:

- Stock `qwen2.5-coder:7b` returns tool calls as bare JSON text in `content`, never in
  `tool_calls`, even with a firm system prompt at temperature 0. Its template asks for
  `<tool_call>` tags the model does not emit, so Ollama does not parse them.
- Fix, no download: a derived local model `qwen2.5-coder-tools:7b` (`ollama create` from
  `ollama show qwen2.5-coder:7b --modelfile`, with the `<tool_call>` tags removed from the
  template's tool section). Ollama then returns real `tool_calls`. Remove with
  `ollama rm qwen2.5-coder-tools:7b`.
- Registered in TrueForge as custom provider `ollama`
  (`base_url http://127.0.0.1:11434/v1`), model `qwen-coder-tools-7b`.
- `llama3:latest` is rejected by Ollama: "does not support tools". LM Studio's
  `qwen2.5-coder-14b-instruct` could not load (about 9 GB, 3 to 6 GB RAM free).

What the small model did, which matters for Days 2 to 4:

- It copied the `read_file` line-number gutter into `new_text` (`"4  This is a new line."`).
  Consider a gutter the model will not copy, or strip a leading `N  ` in `propose_write`.
- After an allowed `propose_write` it read the file again and proposed the same edit a
  second time, with epoch 1 instead of 0. Stale-epoch rejection and idempotent hunk IDs
  (AGENTS.md section 3) cover this; the instructions should say the run's epoch clearly.
- It told the user the file "has been updated" once, despite instructions to say staged.
- Warm, a full turn takes about 3 s. Cold load can exceed TrueForge's ~60 s headers
  timeout (`Headers Timeout Error`).

## Not yet verified

- A hand click on the Allow/Deny notification. The integration test answers approvals
  through a test-only command argument; the notification code path (`askApproval`) has not
  been clicked. Computer use was not available in this session.
- `preload_tools` (deferred tool loading); the Day 1 agent uses `preload: true`.
- Cancel of a running (not paused) turn.
