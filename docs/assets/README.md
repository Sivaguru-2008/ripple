# Screenshots to capture

No screenshots are committed yet. Add real ones here; do not use mock-ups. Each moment below already appears in the submitted [demo video](https://youtu.be/ZeoBrU6ugYo), so you can capture it from the running extension (see the [judge walkthrough](../judge-walkthrough.md)) or export the frame from the original recording at the timestamp given.

| File name | What it must show | Video moment |
|---|---|---|
| `hunk-review.png` | Task A review tab: green and red line decorations and an **Accept \| Reject** CodeLens above each of the 2 hunks in `get_debug_flag` | 00:32 |
| `context-receipt.png` | Agent panel during Task B: budget, used and remaining tokens; each file with its reason and co-change evidence (for example "changed with src/flask/cli.py in 48 commits"); the evicted candidates | 01:28 |
| `fallback-clean.png` | Task C: the Output log or notification saying the fallback model took over, the review it opened, and a terminal showing `git status` clean while the review is open | 03:16 to 03:38 |

Capture at 1920×1080 or larger, crop to the relevant area, and keep the editor theme and font readable. Before committing, check every image for local paths, user names, notifications from other apps, and API keys (the Output log and terminal can show them).

Once added, reference them from the top-level README under "What is different" or "What a judge can verify", with a one-line caption saying which task and timestamp each shows.
