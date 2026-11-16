# RESEARCH.md: Ripple reference findings

Companion to `AGENTS.md`. `AGENTS.md` says what to build and the rules; this file
holds what was learned from the TrueForge source and the reference repos on
16 Nov 2026. Read this before writing any TrueForge SDK call, MCP wiring, diff UI
or retrieval code. Update it whenever a finding is confirmed or proven wrong.

## 1. TrueForge API findings

Answers below were read from the TrueForge repo at commit `18b5718` (docs and
`packages/trueforge-sdk/reference.md`) on 16 Nov. They are **read from docs, not
yet confirmed by a running round trip**. Tick each box only after the smoke
test proves it.

- [ ] **Approval pause and resume (0.185.0+ lifecycle).** Stream opens with
      `turn.created` (gives `turnId`). When approval is needed the stream emits
      `tool.approval_required`, then `turn.update` with `state.status: "paused"`.
      Do NOT send a new turn; it fails while one is paused. Resume with:
      1. `client.sessions.subscribeToTurn(sessionId, turnId, { afterEventId: lastEventId })`
      2. `client.sessions.createTurnEvents(sessionId, turnId, { events: [{ type: 'user.tool_approval', threadId, toolCallId, approval: { status: 'allow' | 'deny' } }] })`
      3. read the subscription until `turn.done`.
      Source: `docs/announcements/turn-lifecycle-0-185-0.mdx`, `docs/api/use-agent.mdx`.
      Older guides and other entries that read `required_actions` from
      `turn.done` are out of date.
- [ ] **MCP registration.** `client.settings.mcpServers.createOrUpdate({ manifest:
      { name, description, type: 'remote', url, auth: { type: 'header', headers:
      { Authorization: 'Bearer ...' } } } })` (`reference.md` near line 4450).
- [ ] **Localhost is blocked by default.** TrueForge's outbound SSRF guard
      rejects `127.0.0.1` and `localhost`. Start TrueForge with
      `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`. On Windows PowerShell:
      `$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'; npx @truefoundry/trueforge@0.185.1`.
      This must be in the README setup steps.
- [ ] **Forcing approval.** In the agent spec's `mcp_servers` entry,
      `require_approval_for_tools` accepts annotation selectors
      (`["@write", "@destructive"]`) or literal tool names
      (`["propose_write", "run_command"]`). Use literal names.
- [ ] **Deferred tools.** `preload: false` is the default (tools discovered via
      meta tools); `preload_tools: [...]` eagerly loads named tools. Preload
      `read_file`, `search_workspace`, `retrieve_context`, `propose_write`;
      leave `run_command` deferred. This is the B4 context-engineering feature.
- [ ] **No native model fallback.** TrueForge retries transient transport
      errors but does not fail over between models. Fallback is client-managed
      and still goes only through TrueForge:
      detect turn failure, then either
      (a) `client.sessions.update(sessionId, { agent: { spec: fallbackSpec } })`
      and re-send the turn (inline-spec sessions only, `reference.md` near line 2062), or
      (b) create a fresh session with the fallback spec and replay the request.
      Prefer (b) for inline edit because it has no history to carry. Before
      replaying, bump the epoch and drop staged hunks from the failed run.
- [ ] **Cancel.** `client.sessions.cancel(sessionId)` aborts a running or
      paused turn; the stream ends with `turn.done` and `status: "cancelled"`.
- [ ] **Token delta event name.** NOT yet identified. Find it in
      `docs/api/use-agent.mdx` (`isEventDelta`, `mergeEventDelta` helpers) and
      record it here.

Agent spec shape (`packages/trueforge-core/src/agent-session/schemas/agentSpec.ts`):
`model: { name }`, `instructions`, `messages`, `mcp_servers[]`, `skills`, `config`.
Sessions are created from the committed `agents/*.json` passed as an inline spec,
which is what makes `sessions.update` available.

Pinned versions: SDK `@truefoundry/trueforge-sdk` `0.185.0` (from the cloned
repo). TrueForge server `@truefoundry/trueforge` `0.185.1`: always start it with
the version given explicitly (`npx @truefoundry/trueforge@0.185.1`). The server
must be 0.185.0 or later to match the pause lifecycle above. Do not upgrade.

## 2. Reference repos and what to take

Cloned at `E:\forge-refs` (outside this repo; never copy whole repos in).
Full notes: `E:\forge-refs\EXTRACTION_NOTES.md`, which also holds a ready-to-paste
"Starting point and borrowed code" section for the README.

| Repo | Commit | Licence | Take | Do not take |
|---|---|---|---|---|
| `truefoundry/trueforge` | `18b571810ffd2fef29fd79e3731b8fb4295f92cf` | MIT | Patterns only: agent spec, lifecycle, registration | n/a |
| `juehang/vscode-mcp-server` | `4f5162f4881ec02d03c65cd1ff029ae70fc468dc` | MIT | `src/server.ts` (Express + `McpServer` + `StreamableHTTPServerTransport`, `POST /mcp`); read, symbol and diagnostics handlers in `src/tools/` | `edit-tools.ts`, move/rename/copy in `file-tools.ts`, `shell-tools.ts`: all write to disk unfenced |
| `continuedev/continue` | `5522c6f44ca0ac3528b37244818fbfa39b5af470` | Apache-2.0 | `extensions/vscode/src/diff/vertical/decorations.ts`, `.../codeLens/providers/VerticalPerLineCodeLensProvider.ts`, `.../vertical/util.ts` (VS Code API only) | `diff/vertical/manager.ts` and `handler.ts`: coupled to Continue's core |
| `fl0w1nd/repomap-mcp` | `f0edb03454e0a5d280a3708e61c7c871d3fcc237` | MIT declared in `package.json` and README; no LICENSE file in tree | `src/pagerank.ts` (91 lines, no deps); budget binary search in `src/repomap.ts` lines 220-246 | `tags.ts` (tree-sitter WASM is too heavy to bundle this week) |
| `pallets/flask` | `22d924701a6ae2e4cd01e9a15bbaf3946094af65` (tag 3.1.3, 5,463 commits) | BSD-3-Clause | Nothing. Test workspace only | n/a |

Rules for borrowed files: keep the original copyright header, add a line naming
the source repo and commit, and for Apache-2.0 files state that the file was
modified. Wire Continue's decorations and CodeLens to Ripple's
`TransactionManager`, not to anything from Continue. MCP SDK in the reference
is `@modelcontextprotocol/sdk` 1.32.2 with `express` and `zod`.

## 3. Co-change evidence and how to score it

Measured on Flask 3.1.3 for `src/flask/cli.py` (176 commits with `--follow`,
65 on the current path). Files changed in the same commits:

| File | Shared commits | Note |
|---|---|---|
| `tests/test_cli.py` | 55 (follow) / 26 (path) | Task B test target |
| `CHANGES.rst` | 35 | Changes with almost everything: noise unless normalised |
| `docs/cli.rst` | 20 | Task B docs target |
| `src/flask/app.py` | 19 | |
| `src/flask/helpers.py` | 18 | |
| `src/flask/testing.py` | 14 | |
| `src/flask/config.py` | 11 | Subject of the `flask config` command |

Design consequences:

- **Do not rank by raw shared-commit count.** It favours files that change
  everywhere (`CHANGES.rst`, `app.py`). Score with a normalised measure, e.g.
  `shared / sqrt(commits(a) * commits(b))` or Jaccard, and skip commits that
  touch more than about 20 files.
- **Follow renames** (`git log --follow` or `-M`), otherwise history before the
  `src/` move is lost and counts halve.
- **Co-change needs a seed file.** The seed comes from lexical and symbol
  search on the request ("CLI command" leads to `cli.py`); co-change then
  expands from the seed to the test and docs files.
- **Show the evidence in the receipt**, e.g. "`docs/cli.rst`: changed with
  `cli.py` in 20 commits".
- PageRank, if used at all, runs over this file graph (co-change, imports,
  lexical), not over tree-sitter tags.
