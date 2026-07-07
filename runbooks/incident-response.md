# ToolGuard Incident Response

## Scope

Use this runbook when a ToolGuard route, demo, wrapper, or evidence export fails unexpectedly.

## Triage

1. Capture the failing command, package, route, and run ID.
2. Inspect `runs/<run-id>/events.jsonl` and the exported evidence bundle.
3. Check redaction summaries before sharing output.
4. Use `pnpm doctor:integrations` for route coverage and integration receipts.
5. File an issue using the bug template with the evidence bundle or safe excerpts.

## Recovery

- For CLI failures, rerun through `toolguard run --` with the same arguments only after checking policy guidance.
- For MCP failures, check downstream preflight status and circuit state.
- For UI failures, verify Core is reachable at `http://127.0.0.1:3660/health`.
- For Python adapter failures, verify `TOOLGUARD_SIDECAR_ENDPOINT` points to the local sidecar API.
