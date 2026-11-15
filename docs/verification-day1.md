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

## Not yet verified

- A hand click on the Allow/Deny notification. The integration test answers approvals
  through a test-only command argument; the notification code path (`askApproval`) has not
  been clicked. Computer use was not available in this session.
- A real LLM end to end. Local `qwen2.5-coder:7b` (Ollama 0.40.16) returns tool calls as
  JSON text in `content`, not in `tool_calls`, so TrueForge ends the turn after one message.
  This is the model's template, reproduced directly against Ollama. LM Studio's
  `qwen2.5-coder-14b-instruct` could not load (about 9 GB needed, 5.6 GB RAM free).
- `preload_tools` (deferred tool loading); the Day 1 agent uses `preload: true`.
