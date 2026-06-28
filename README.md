# Toolplane / ToolGuard

**ToolGuard is a protocol-independent ToolOps layer for AI agent tool calls: it mediates execution, records evidence, redacts unsafe output, normalizes failures, and makes tool behavior inspectable across direct, MCP, CLI, and Python-framework paths.**

Toolplane is the monorepo. ToolGuard is the product surface in it.

```
AI agent, eval harness, or dev workflow
        |
        | direct call | MCP route | CLI wrapper | Python adapter
        v
+----------------------+        +-----------------------------+
| ToolGuard adapters   | -----> | normalized ToolGuard call   |
+----------------------+        +-----------------------------+
        |                                    |
        v                                    v
+----------------------+        +-----------------------------+
| ToolGuard Core       | -----> | events, evidence, reports   |
| policy + execution   |        | redaction, replay metadata  |
+----------------------+        +-----------------------------+
        |
        v
Downstream tools, processes, fixtures, or MCP servers
```

## Why this exists

AI agents are getting better at deciding *what* to call. The operational layer around those tool calls is still brittle.

Tool calls fail in ways that are hard to debug and easy to make unsafe:

- A downstream tool crashes, hangs, returns malformed protocol data, or emits prompt-injection text.
- A command exits non-zero, floods the model context, leaks secret-shaped data, or tries to mutate the workspace.
- An adapter knows a call failed, but loses correlation between the harness, adapter, server, tool call, attempt, policy decision, and raw artifact.
- A demo, evaluation, or incident review needs replayable evidence instead of screenshots and hand-written explanations.

ToolGuard makes tool execution observable, policy-aware, and replayable without making MCP, a shell, a UI, or a Python framework the core abstraction.

## Quick start

Requirements from the repo metadata:

- Node.js `>=22.0.0`
- `pnpm` `10.25.0`
- Python 3 for `@toolplane/python-adapters`

```bash
pnpm install
pnpm build
pnpm test
```

Run the smallest before-and-after demo:

```bash
pnpm demo:raw-failure
pnpm demo:toolplane
```

The raw demo runs the same deterministic fixture without mediation. The ToolGuard demo records a run under `runs/`, emits correlated events, produces a Failure Card, and exports static evidence.

## Demo commands

```bash
# Baseline unmediated deterministic fixture failure
pnpm demo:raw-failure

# Core direct-run mediation demo
pnpm demo:toolplane

# MCP adapter demo
pnpm demo:mcp

# Portfolio demo with local loopback Core/UI surfaces and cleanup checks
pnpm demo
```

The demos are local-first and fixture-driven. They do not require cloud credentials or external services for the core evidence paths.

## What ToolGuard solves

### Typed failures instead of raw chaos

ToolGuard turns tool failures into normalized Failure Cards with root cause, retryability, safe recovery options, human fix guidance, evidence links, safe summaries, and `rawDetailsSeparated: true`.

Failure classes implemented in the core types include:

- `unknown_tool`
- `invalid_arguments`
- `timeout`
- `cancellation`
- `cwd_mismatch`
- `malformed_json`
- `process_crash`
- `non_zero_exit`
- `spawn_failure`
- `output_limit_exceeded`
- `prompt_injection_output`
- `secret_leak_risk`
- `destructive_action_blocked`
- `circuit_open`
- `policy_blocked`
- `sidecar_unavailable`
- `sidecar_protocol_error`

### Protocol-independent ToolOps

The core models harnesses, adapters, protocols, tool calls, results, policy decisions, events, traces, artifacts, reports, and replay metadata. MCP, CLI, Python, UI, and fixture paths sit around the core rather than inside it.

That boundary is tested. `@toolplane/core` exports the product names, IDs, event bus, registry, session runtime, evidence recorder, report exporter, redaction helpers, classifier, sidecar API, and chaos fixtures without importing adapter, UI, MCP SDK, LangGraph, CrewAI, React, Vite, or Tailwind code.

### Safety gates before execution

ToolGuard evaluates policy before downstream execution. High-risk destructive calls are blocked unless they are explicitly fixture-only. Retry behavior is bounded and tied to idempotency. Circuit breakers fast-fail repeated target failures and close after cooldown recovery.

### Redaction before model-facing output

ToolGuard treats suspicious output as hostile until proven safe. The repo includes detection and redaction for prompt-injection-like text, bearer tokens, OpenAI-style keys, API-key assignments, private keys, token-shaped values, and sensitive JSON keys.

### Evidence that engineers can inspect

ToolGuard separates safe model-facing summaries from raw artifacts engineers may need for debugging.

```
raw downstream data
        |
        v
evidence artifacts on disk ---- sha256/hash manifest
        |
        v
redaction + classification
        |
        v
safe summary / Failure Card / report
```

Typical demo output under `runs/` includes `events.jsonl`, raw artifacts, `report.html`, `manifest.json`, `artifact-hashes.json`, and `redaction-summary.json`.

## Architecture and monorepo layout

```
toolplane/
  package.json                    root scripts and workspace metadata
  pnpm-workspace.yaml             workspace package list
  packages/
    core/                         protocol-independent contracts and runtime
    cli/                          process wrapper exposed as toolplane/toolguard
    mcp-adapter/                  MCP proxy/router and portfolio demo orchestration
    python-adapters/              thin LangGraph and CrewAI wrapper adapters
    ui/                           local React/Vite observability UI
  runs/                           local generated evidence from demos and wrappers
```

## Package map

| Package | Role | Grounded surfaces in this repo |
| --- | --- | --- |
| `@toolplane/core` | Protocol-independent ToolGuard runtime | `CoreSession`, `ToolRegistry`, `EventBus`, `EvidenceRecorder`, `exportStaticReport`, `validateReportManifest`, `createCoreApiServer`, `SIDECAR_PROTOCOL_VERSION`, redaction, classifier, chaos fixtures |
| `@toolplane/cli` | Safe process wrapper for shell, git, tests, and coding-agent supervision | `toolplane` and `toolguard` bins, `toolplane run -- <command>`, argv boundary preservation, timeout/cancellation, output limits, environment redaction, destructive command blocking |
| `@toolplane/mcp-adapter` | MCP proxy/router between upstream MCP clients and downstream tools | deterministic virtual tool names, downstream preflight, MCP-compatible Failure Cards, SDK boundary tests, config snippet generation with MCP-routed-only limitations, portfolio demo |
| `@toolplane/python-adapters` | Thin framework adapters for Python agent stacks | sidecar client, LangGraph wrapper, CrewAI wrapper, loopback-only sidecar endpoint validation, fail-closed protocol checks |
| `@toolplane/ui` | Local observability UI | overview, live timeline, health matrix, failure inbox, trace explorer, replay lab, policy studio, harness integrations, evidence report viewer |

## Development commands

Root scripts:

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm demo
pnpm demo:mcp
pnpm demo:raw-failure
pnpm demo:toolplane
pnpm dev:core
pnpm dev:ui
```

Package-scoped examples:

```bash
pnpm --filter @toolplane/core test
pnpm --filter @toolplane/cli test
pnpm --filter @toolplane/mcp-adapter test
pnpm --filter @toolplane/python-adapters test
pnpm --filter @toolplane/ui test
```

CLI wrapper example after build:

```bash
pnpm --filter @toolplane/cli exec toolguard run -- git status --short
```

`dev:core` and `dev:ui` start local loopback development servers. They are not required for the test suite.

## Validation evidence

The repository test suite covers the public claims above:

- **Core boundaries:** product naming is centralized, and Core does not import adapter, UI, MCP, or framework-specific code.
- **Execution lifecycle:** events are append-only, correlation fields are stable, and direct plus adapter-originated calls normalize into the same core model.
- **Failure handling:** unknown tools, invalid arguments, timeouts, cancellation, downstream crashes, malformed JSON, non-zero exits, output limits, and preflight failures produce safe Failure Cards and evidence.
- **Policy and resilience:** destructive calls are blocked before downstream execution, fixture-only destructive simulations do not mutate real files, retries are bounded, unsafe non-idempotent calls are not retried automatically, and circuits open/close by target.
- **Evidence and redaction:** secret-shaped output is redacted from user-visible strings and exported reports, raw details stay separated, report manifests validate artifact hashes, and redaction summaries count changes.
- **CLI wrapper:** argv boundaries are preserved without shell interpretation, stdout/stderr and exit status are captured, timeouts and cancellation terminate child process trees, output limits are enforced, environment output is redacted, safe git reads work, and destructive shell/filesystem/git patterns are blocked.
- **MCP adapter:** virtual tools are deterministic, downstream calls route to the intended server, unhealthy preflight fails fast, MCP-compatible Failure Cards are returned, prompt-injection output is contained, malformed protocol data does not crash the router, deadlines are enforced, and circuit fast-fail behavior is covered.
- **Python adapters:** LangGraph and CrewAI wrappers route through the sidecar protocol, preserve correlation fields, validate loopback endpoints, and fail closed when the sidecar is unavailable or incompatible.
- **UI model:** ToolOps screens are backed by Core API payloads for overview counts, correlation fields, timeline events, and health matrix labels.
- **Portfolio demo:** acceptance tests cover required event types, deterministic chaos fixture rows, replay status, redaction scans, integration overclaim scans, report artifacts, and cleanup.

Run the full local validation suite:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

## Safety, redaction, and replay concepts

- **Raw evidence is separated:** raw stdout, stderr, and downstream results are written as local artifacts and linked by ID.
- **Safe summaries are model-facing:** report data and user-visible event payloads pass through redaction helpers before display.
- **Output budgets are enforced:** oversized stdout, stderr, or result payloads become bounded failures instead of flooding context.
- **Replay is constrained:** replay endpoints expose metadata and block real-world or destructive command replay unless the request is fixture-only and safe.
- **Sidecar endpoints are local-only:** Python adapter configuration rejects non-loopback sidecar endpoints.
- **Process execution avoids shell expansion:** CLI execution preserves explicit argv boundaries and uses `shell: false`.

## Status

ToolGuard here is an early, local-first implementation. The packages are private workspace packages at version `0.0.0`, and the strongest current evidence is the checked-in test suite plus deterministic demos.

This repo does **not** claim native interception of host tools that are not routed through ToolGuard. It does **not** claim production cloud integrations or credential-backed external services. It does claim a working protocol-independent core, MCP route, CLI wrapper, Python sidecar adapters, local observability UI, evidence reports, redaction, policy gates, replay fixtures, and validation coverage for those surfaces.
