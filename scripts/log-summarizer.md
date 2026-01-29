# Log Summarizer

Purpose: post-run log reduction + correlation for closed-join / blind-peer workflows.

## Usage

```bash
node scripts/log-summarizer.mjs --out log-summaries --run closed-join-run1 \
  test-logs/CLOSED-JOIN-WORKFLOW/test3-FAIL-closed-join-offline/worker2.log \
  test-logs/CLOSED-JOIN-WORKFLOW/test3-FAIL-closed-join-offline/public-gateway2.log
```

Outputs (under `log-summaries/<run-id>/`):
- `summary.json`: trace index + overall counts
- `error-index.json`: grouped errors (message/stack hash)
- `untraced.timeline.txt`: critical lines without `inviteTraceId`
- `traces/<inviteTraceId>.json`: compact per-trace summary
- `traces/<inviteTraceId>.timeline.txt`: chronological timeline for the trace

## Filtering rules

The summarizer keeps:
- All lines containing `inviteTraceId`
- All `[CJTRACE]` lines
- Warnings/errors/failures
- Blind-peer/mirror/join-auth related events

Everything else is dropped to reduce volume while preserving critical workflow signal.
