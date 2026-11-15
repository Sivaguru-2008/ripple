# Ripple

A VS Code extension that is a coding agent whose agent loop runs on
[TrueForge](https://github.com/truefoundry/trueforge). Built for Round 1 of the
TrueFoundry Forge-a-thon.

Status: Day 1, round trip only (session, streamed turn, MCP tool call, approval pause).

## Quick start (Windows, PowerShell)

1. Start TrueForge in local mode, allowing it to reach the extension's MCP server on
   loopback:

   ```powershell
   $env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'; npx @truefoundry/trueforge@0.185.1
   ```

2. Open http://localhost:8790, go to **Settings → Models**, and add a provider. Then edit
   `model.name` in `agents/ripple-agent.json` to a model you configured
   (format `provider/model`). Keys stay in TrueForge, never in this repo.
3. `npm install`, then open this folder in VS Code and press **F5**.
4. In the Extension Development Host, run **Ripple: Smoke Test** from the Command Palette
   and watch the **Ripple** output channel.

## Starting point and borrowed code

Ripple was started from an empty repository. No code was copied from other projects.

Runtime dependencies (used as libraries, not copied):

| Package | Version | Licence | Repository |
|---|---|---|---|
| `@truefoundry/trueforge-sdk` | 0.185.0 | MIT | https://github.com/truefoundry/trueforge |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| `zod` | 4.6.7 | MIT | https://github.com/colinhacks/zod |

## Licence

MIT. See [LICENSE](LICENSE).
