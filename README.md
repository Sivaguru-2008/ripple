# Ripple

A VS Code extension that is a coding agent whose agent loop runs on
[TrueForge](https://github.com/truefoundry/trueforge). Built for Round 1 of the
TrueFoundry Forge-a-thon.

## Quick start

Full steps, troubleshooting and every bottleneck seen so far: [docs/runbook.md](docs/runbook.md).

1. `npm install`
2. Put a model key in `.env` (git-ignored), for example `GEMINI_API_KEY=...` from Google AI
   Studio's free tier. Keys never go in this repository.
3. `npm run demo:prepare`: clones pallets/flask 3.1.3 into `../flask-demo` and writes
   `.env.demo` so the agent's test commands use a Python with pytest.
4. `npm run stack`, and leave it running. It starts TrueForge in local mode
   (`npx @truefoundry/trueforge@0.185.1`, with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'` so
   TrueForge may reach the extension's MCP server on loopback), starts the model adapter
   (`scripts/gemini-proxy.mjs`), and registers the providers in
   `config/trueforge.models.example.json` in TrueForge.
5. Open this folder in VS Code and run the launch configuration **Run Ripple on the Flask
   demo**. Ripple registers its MCP server in TrueForge as the connector `ripple` and loads the
   agent from `agents/ripple-agent.json` (inline edits use `agents/ripple-inline.json`).

Models are configured only in TrueForge; Ripple never calls a provider. The adapter is a model
endpoint registered in TrueForge, not part of the extension. Switch models by editing
`model.name` (`provider/model`) in `agents/*.json` and `ripple.fallbackModel`.

The `ripple.trueforgeBaseUrl` setting defaults to `http://localhost:8790`. Use `localhost`,
not `127.0.0.1`: on Windows TrueForge listens on `::1` only.

## Development

```powershell
npm run typecheck
npm test
npm run build
```

`npm run test:vscode` runs **Ripple: Smoke Test** inside a real VS Code Extension
Development Host (allow and deny paths). It needs TrueForge running as in step 1; it starts
a scripted mock model on `127.0.0.1:8792` and registers it in TrueForge as the provider
`ripple-mock`, so no API key is needed. The mock is a test fixture; the extension never
talks to a model.

## Starting point and borrowed code

Ripple was started from an empty repository; it is not a fork. Two files adapt editor-side code
from [Continue](https://github.com/continuedev/continue) at commit
`5522c6f44ca0ac3528b37244818fbfa39b5af470` (Apache License 2.0; licence text in
[licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)). Each keeps Continue's copyright and licence
header and says what was changed:

| Ripple file | Continue file at that commit | What Ripple changed |
|---|---|---|
| `src/ui/decorations.ts` | `extensions/vscode/src/diff/vertical/decorations.ts` | Removed the index decorations of Continue's streaming diff, added index guards and `dispose()`; driven by Ripple's review controller |
| `src/ui/hunkCodeLens.ts` | `extensions/vscode/src/lang-server/codeLens/providers/VerticalPerLineCodeLensProvider.ts` | Lenses carry a Ripple proposal id, hunk id and decision; commands are `ripple.acceptHunk` / `ripple.rejectHunk`; decided hunks show their status; a file-level Accept all / Reject all lens; no dependency on Continue's diff manager |

Continue's agent loop is not used: the loop runs on TrueForge. No code comes from other
Forge-a-thon entries.

Runtime dependencies (used as libraries, not copied):

| Package | Version | Licence | Repository |
|---|---|---|---|
| `@truefoundry/trueforge-sdk` | 0.185.0 | MIT | https://github.com/truefoundry/trueforge |
| `@truefoundry/trueforge` (server, started with `npx`) | 0.185.1 | MIT | https://github.com/truefoundry/trueforge |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| `zod` | 4.6.7 | MIT | https://github.com/colinhacks/zod |

## Licence

MIT. See [LICENSE](LICENSE). The two files adapted from Continue remain under the Apache
License 2.0 ([licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)).
