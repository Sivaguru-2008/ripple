# Showcase audit (21 Nov 2026)

An audit of how the public repository presents the Round 1 submission, and what changed on the `codex/showcase-polish` branch. The submitted code and artifacts (`master` at `491c092`, the write-up PDF, the video, the agent definitions) were not changed.

## Gaps found

| Area | Finding | On this branch |
|---|---|---|
| First screen | Tagline and three pillars present, but the value proposition was spread over several bullets and the demo link sat in section 5 | One-sentence tagline, 5-sentence explanation, video, write-up and walkthrough links above the fold |
| Verification | Scorecard listed timestamps but not which claims had automated evidence | "What a judge can verify" table: what to look for, video timestamp, evidence and its source |
| Architecture | One Mermaid diagram in the README; no separate explanation of design decisions | `docs/architecture.md`: request path, sequence diagram, three design decisions with their costs |
| Running it | Quick start in the README; Windows troubleshooting only in `docs/runbook.md` | `docs/judge-walkthrough.md`: setup, what to look for in each task, verification commands, automated checks, evidence, troubleshooting |
| Security and privacy | Not stated in one place | README section: no direct model calls, keys outside the extension, local authenticated MCP server, reviewed writes, approval-gated commands |
| Accuracy | README said fallback "switches the TrueForge session" to the second model; the code (`src/trueforge/runner.ts`) starts a **new** session with the fallback model on the same Ripple transaction | Corrected in the README and explained in `docs/architecture.md`. The submitted write-up (§3 and the design list) says the second model "continues the same thread"; it was left unchanged because it is a submitted artifact |
| Accuracy | `AGENTS.md` §3 and §6 describe an `epoch` argument for fencing; the code fences with a per-run MCP URL token instead (`checkRun(runToken)` in `src/mcp/server.ts`) | New docs describe the run token; `AGENTS.md` left unchanged |
| Accuracy | `docs/BUILD_SPEC.md` §6.2 says compaction triggers at 12,000 tokens; `agents/ripple-agent.json` uses 20,000 | Not linked from the new README; file left unchanged (owner's decision) |
| Screenshots | None in the repository | `docs/assets/README.md` lists the three to capture, with video timestamps; no generated images |
| CI | No GitHub Actions workflows | No CI badge added; static badges only state facts from the repository |
| GitHub metadata | Description set; no topics, homepage, releases or social preview | Checklist below (settings, not files) |

## GitHub settings for the owner

These are repository settings, not files; none were changed.

**Description** (About → edit):
```
VS Code coding agent on TrueForge: per-hunk reviewed edits, a context receipt for every retrieval, and automatic model fallback.
```

**Website:** `https://youtu.be/SXWVulFGhJc` (the demo video).

**Topics:** `vscode-extension`, `coding-agent`, `trueforge`, `mcp`, `model-context-protocol`, `typescript`, `code-review`, `retrieval`, `developer-tools`, `forge-a-thon`.

**Release** (only after Round 1 results, so the submission is not seen as changing):
- Tag: `round1-submission` on commit `491c092`.
- Title: `Round 1 submission: Forge-a-thon 2026`.
- Body:
  ```
  The code, agent definitions and write-up as submitted for Round 1 of the TrueFoundry Forge-a-thon (Techfest IIT Bombay 2026-27) on 20 Nov 2026.

  - Demo video (3:53): https://youtu.be/SXWVulFGhJc
  - Write-up: docs/writeup.pdf
  - TrueForge 0.185.1, @truefoundry/trueforge-sdk 0.185.0
  - 168 unit tests; Tasks A and C pass in the automated VS Code checks; Task B passed 3 of 7 attempts on free Gemini Flash-Lite (see Known limitations)
  ```

**Social preview** (Settings → General → Social preview): a PNG or JPG of 1280×640 px, under 1 MB, with the name "Ripple", the tagline, and one real frame of the per-hunk review (video 00:54). No generated UI.

**Other:** turn off Wiki (unused) to keep navigation short; keep Issues on if you want feedback.

## Not claimed, because it is not proven

- A Task B pass rate.
- Performance on macOS or Linux.
- Behaviour with models other than those listed in the write-up.
- A Task B run after submission.
- Any CI status.
