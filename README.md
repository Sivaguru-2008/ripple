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

Ripple was started from an empty repository. No code was copied from other projects.

Runtime dependencies (used as libraries, not copied):

| Package | Version | Licence | Repository |
|---|---|---|---|
| `@truefoundry/trueforge-sdk` | 0.185.0 | MIT | https://github.com/truefoundry/trueforge |
| `@truefoundry/trueforge` (server, started with `npx`) | 0.185.1 | MIT | https://github.com/truefoundry/trueforge |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| `zod` | 4.6.7 | MIT | https://github.com/colinhacks/zod |

## Licence

MIT. See [LICENSE](LICENSE).
