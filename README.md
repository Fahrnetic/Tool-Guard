# ToolGuard

> A local-first ToolOps reliability layer for AI-agent tool calls. ToolGuard mediates routed tool execution, records evidence, redacts unsafe output, normalizes failures into Failure Cards, and makes tool behavior inspectable and replayable.

<p>
  <!-- Static badges: no CI dependency, no fabricated workflow references. -->
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10.25.0-F69220?logo=pnpm&logoColor=white" />
  <img alt="Python" src="https://img.shields.io/badge/python-3-3776AB?logo=python&logoColor=white" />
  <img alt="Scope" src="https://img.shields.io/badge/scope-local--first-2A2A2A" />
  <img alt="Status" src="https://img.shields.io/badge/status-demo--ready-blue" />
  <img alt="Packages" src="https://img.shields.io/badge/packages-private%20workspace%200.0.0-555" />
  <img alt="License" src="https://img.shields.io/badge/license-not%20specified-lightgrey" />
</p>

Toolplane is the monorepo. **ToolGuard** is the product surface in it. It works across four routed integration paths, direct core calls, MCP routes, a CLI wrapper, and thin Python adapters, and exposes a local observability UI for command center, live timeline, topology, failure inbox, trace explorer, replay lab, policy studio, story mode, validation dashboard, and evidence bundle viewer.

> Tools must be routed, wrapped, or supervised through ToolGuard. ToolGuard does **not** natively intercept arbitrary host tools that bypass it.

---

## Why it exists

AI agents are getting better at deciding *what* to call. The operational layer around those calls is still brittle. Tool calls fail in ways that are hard to debug and easy to make unsafe:

| Symptom | What happens today | What ToolGuard does |
| --- | --- | --- |
| Downstream crash / hang / malformed data | Adapter loses correlation between harness, server, tool call, attempt, and artifact | Stitches every hop into one correlated event stream |
| Non-zero exit, context flood, secret-shaped output | Raw stdout floods the model or leaks bearer/private keys | Enforces output budgets and redacts before model-facing output |
| Destructive or injected command | Workspace mutated or injection text reaches the model | Policy gates block before execution; injection text is contained |
| Incident / eval review | Screenshots and hand-written explanations | Replayable evidence bundle with hashes, manifests, and receipts |

ToolGuard makes tool execution observable, policy-aware, and replayable, without making MCP, a shell, a UI, or a Python framework the core abstraction.

---

## What it does

- **Mediates routed execution** across direct core calls, MCP routes, CLI wrapper, and Python sidecar adapters.
- **Normalizes failures** into typed Failure Cards with root cause, retryability, recovery options, fix guidance, and evidence links.
- **Enforces policy gates** before downstream execution: destructive-call blocking, bounded retries tied to idempotency, and target-scoped circuit breakers.
- **Redacts unsafe output** before it reaches the model: prompt-injection text, bearer tokens, OpenAI-style keys, API-key assignments, private keys, token-shaped values, sensitive JSON keys.
- **Records evidence** on disk: append-only events, raw artifacts separated from safe summaries, hash manifests, redaction summaries, reports, and exportable evidence bundles.
- **Scores consequences**: side-effect ledger, blast-radius scoring, retry-loop detection, failure topology map, and run health narrative.
- **Provides local UI surfaces** for end-to-end inspection and replay.

---

## Quick start

Requirements from repo metadata:

| Requirement | Version |
| --- | --- |
| Node.js | `>=22.0.0` |
| pnpm | `10.25.0` |
| Python | `3` (for `@toolplane/python-adapters`) |

```bash
pnpm install
pnpm build
pnpm test
```

### Demo quickstart

```bash
# 1. Baseline: run a deterministic fixture with NO mediation, observe raw failure
pnpm demo:raw-failure

# 2. Same fixture routed through ToolGuard: normalized Failure Card + evidence
pnpm demo:toolplane

# 3. MCP adapter demo
pnpm demo:mcp

# 4. Portfolio demo with local loopback Core/UI surfaces and cleanup checks
pnpm demo

# 5. Persistent guided story-mode demo for human review
pnpm demo:serve
```

All demos are local-first and fixture-driven. They do **not** require cloud credentials or external services for the core evidence paths.

`pnpm demo:serve` runs the flagship story-mode stack on approved loopback ports only:

| Surface | Address |
| --- | --- |
| Core / API / SSE | `http://127.0.0.1:3660` |
| UI | `http://127.0.0.1:3661` |
| Fixture stack | `http://127.0.0.1:3662`-`3664` |

The launcher refuses ports outside the approved `3660-3669` range and traps shutdown to clean up ToolGuard-owned processes.

### Demo-ready visual surfaces

The demo is designed to read clearly on screen: start with the before/after arc, then use the command center, failure topology map, story mode, validation dashboard, and evidence bundle viewer to show how a raw tool failure becomes a routed, redacted, replayable ToolGuard run. These surfaces stay local-first and reflect only routed, wrapped, or supervised paths; ToolGuard does not natively intercept host tools that bypass it.

---

## Architecture

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

The core is protocol-independent. `@toolplane/core` exports the product names, IDs, event bus, registry, session runtime, evidence recorder, report exporter, redaction helpers, classifier, sidecar API, and chaos fixtures **without** importing adapter, UI, MCP SDK, LangGraph, CrewAI, React, Vite, or Tailwind code. MCP, CLI, Python, UI, and fixture paths sit around the core, not inside it.

### Evidence flow

```
raw downstream data
        |
        v
evidence artifacts on disk ---- sha256 / hash manifest
        |
        v
redaction + classification
        |
        v
safe summary / Failure Card / report
```

Raw evidence is separated from safe summaries. Report data and user-visible event payloads pass through redaction helpers before display.

---

## Monorepo layout

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

### Package map

| Package | Role | Grounded surfaces in this repo |
| --- | --- | --- |
| `@toolplane/core` | Protocol-independent ToolGuard runtime | `CoreSession`, `ToolRegistry`, `EventBus`, `EvidenceRecorder`, `exportStaticReport`, `exportEvidenceBundle`, `validateReportManifest`, `createCoreApiServer`, `SIDECAR_PROTOCOL_VERSION`, side-effect ledger, blast-radius scoring, retry-loop detection, topology, narrative, policy simulator, integration verification, story mode, redaction, classifier, chaos fixtures |
| `@toolplane/cli` | Safe process wrapper for shell, git, tests, coding-agent supervision | `toolplane` and `toolguard` bins, `toolplane run -- <command>`, argv boundary preservation, timeout/cancellation, output limits, environment redaction, destructive command blocking |
| `@toolplane/mcp-adapter` | MCP proxy/router between upstream MCP clients and downstream tools | deterministic virtual tool names, downstream preflight, MCP-compatible Failure Cards, SDK boundary tests, config snippet generation with MCP-routed-only limitations, portfolio demo, persistent `demo:serve` story-mode launcher |
| `@toolplane/python-adapters` | Thin framework adapters for Python agent stacks | sidecar client, LangGraph wrapper, CrewAI wrapper, loopback-only sidecar endpoint validation, fail-closed protocol checks |
| `@toolplane/ui` | Local observability UI | run health command center, live timeline, failure topology map, health matrix, failure inbox, trace explorer, replay lab, demo story mode, validation dashboard, policy studio, harness integrations, evidence bundle viewer |

Packages are private workspace packages at version `0.0.0`. They are **not** published to npm or PyPI.

---

## Safety model

ToolGuard treats suspicious output as hostile until proven safe and evaluates policy before downstream execution.

### Failure classes

ToolGuard normalizes tool failures into typed Failure Cards with root cause, retryability, safe recovery options, human fix guidance, evidence links, safe summaries, and `rawDetailsSeparated: true`.

| Category | Failure classes |
| --- | --- |
| Call shape | `unknown_tool`, `invalid_arguments` |
| Lifecycle | `timeout`, `cancellation` |
| Environment | `cwd_mismatch`, `spawn_failure`, `sidecar_unavailable`, `sidecar_protocol_error` |
| Downstream data | `malformed_json`, `process_crash`, `non_zero_exit`, `output_limit_exceeded` |
| Safety | `prompt_injection_output`, `secret_leak_risk`, `destructive_action_blocked` |
| Policy / resilience | `circuit_open`, `policy_blocked` |

### Policy and resilience

- **Destructive-call blocking:** high-risk destructive calls are blocked before downstream execution unless explicitly fixture-only.
- **Bounded retries:** retries are tied to idempotency; unsafe non-idempotent calls are not retried automatically.
- **Circuit breakers:** repeated target failures fast-fail and circuits close after cooldown recovery.
- **Output budgets:** oversized stdout, stderr, or result payloads become bounded failures instead of flooding model context.
- **No shell expansion:** CLI execution preserves explicit argv boundaries and uses `shell: false`.
- **Loopback-only sidecars:** Python adapter configuration rejects non-loopback sidecar endpoints.

### Redaction surface

Detection and redaction are implemented for prompt-injection-like text, bearer tokens, OpenAI-style keys, API-key assignments, private keys, token-shaped values, and sensitive JSON keys. Secret-shaped output is redacted from user-visible strings and exported reports; raw details stay separated.

---

## Evidence and replay model

Typical demo output under `runs/` includes `events.jsonl`, raw artifacts, `report.html`, `manifest.json`, `artifact-hashes.json`, and `redaction-summary.json`. Demo-ready evidence also includes a side-effect ledger, topology and narrative exports, policy simulation receipts, integration verification receipts, retry-loop summaries, blast-radius summaries, and an exportable evidence bundle with a local viewer.

| Concept | Behavior |
| --- | --- |
| Raw evidence separated | Raw stdout, stderr, and downstream results written as local artifacts, linked by ID |
| Safe summaries model-facing | Report data and user-visible payloads pass through redaction helpers before display |
| Output budgets enforced | Oversized payloads become bounded failures, not context floods |
| Replay constrained | Replay endpoints expose metadata and block real-world or destructive replay unless fixture-only and safe |
| Policy simulation dry-run | Previews outcomes from recorded scenarios without executing new downstream side effects |
| Integration verification scoped | Receipts cover routed, wrapped, or supervised ToolGuard paths only, not native interception of tools that bypass ToolGuard |

---

## Flagship demo arc

The demo-ready product state is built around a before-and-after arc:

1. Run a deterministic fixture directly and observe the raw failure.
2. Route the same fixture through ToolGuard and inspect the normalized Failure Card.
3. Follow the run through the command center, live timeline, failure topology map, health narrative, trace explorer, and failure inbox.
4. Use the policy simulator and integration verification wizard to preview policy outcomes and verify routed, wrapped, or supervised integration paths.
5. Export and view the evidence bundle: report files, manifests, hashes, redaction summaries, topology, policy receipts, integration receipts, replay notes, side-effect ledger rows, blast-radius scoring, and retry-loop findings.

Story mode covers raw malformed failures, prompt-injection containment, destructive fixture blocking, retry-loop containment, malformed MCP responses, CLI non-zero exits, and Python sidecar unavailability. Each scenario uses deterministic fixture or loopback inputs and has reset/cleanup controls for demo hygiene.

---

## Development commands

### Root scripts

```bash
pnpm build          # build all packages
pnpm test           # run all package tests
pnpm typecheck      # typecheck all packages
pnpm lint           # lint all packages
pnpm demo           # portfolio demo
pnpm demo:raw-failure
pnpm demo:toolplane
pnpm demo:mcp
pnpm demo:serve     # persistent story-mode demo
pnpm dev:core       # local loopback core dev server
pnpm dev:ui         # local loopback UI dev server (127.0.0.1:3661)
```

### Package-scoped

```bash
pnpm --filter @toolplane/core test
pnpm --filter @toolplane/cli test
pnpm --filter @toolplane/mcp-adapter test
pnpm --filter @toolplane/python-adapters test
pnpm --filter @toolplane/ui test
```

### CLI wrapper (after build)

```bash
pnpm --filter @toolplane/cli exec toolguard run -- git status --short
```

`dev:core` and `dev:ui` start local loopback development servers. They are not required for the test suite.

---

## Validation commands

Run the full local validation suite:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

The repository test suite covers the public claims above:

- **Core boundaries:** product naming is centralized; Core does not import adapter, UI, MCP, or framework-specific code.
- **Execution lifecycle:** events are append-only, correlation fields are stable, and direct plus adapter-originated calls normalize into the same core model.
- **Failure handling:** unknown tools, invalid arguments, timeouts, cancellation, downstream crashes, malformed JSON, non-zero exits, output limits, and preflight failures produce safe Failure Cards and evidence.
- **Policy and resilience:** destructive calls are blocked before downstream execution, fixture-only destructive simulations do not mutate real files, retries are bounded, unsafe non-idempotent calls are not retried automatically, and circuits open/close by target.
- **Evidence and redaction:** secret-shaped output is redacted from user-visible strings and exported reports, raw details stay separated, report manifests validate artifact hashes, and redaction summaries count changes.
- **Consequence intelligence:** side effects are recorded or blocked in a ledger, blast-radius scores are emitted, retry loops are identified, and topology plus narrative payloads are generated from recorded events.
- **CLI wrapper:** argv boundaries are preserved without shell interpretation, stdout/stderr and exit status are captured, timeouts and cancellation terminate child process trees, output limits are enforced, environment output is redacted, safe git reads work, and destructive shell/filesystem/git patterns are blocked.
- **MCP adapter:** virtual tools are deterministic, downstream calls route to the intended server, unhealthy preflight fails fast, MCP-compatible Failure Cards are returned, prompt-injection output is contained, malformed protocol data does not crash the router, deadlines are enforced, and circuit fast-fail behavior is covered.
- **Python adapters:** LangGraph and CrewAI wrappers route through the sidecar protocol, preserve correlation fields, validate loopback endpoints, and fail closed when the sidecar is unavailable or incompatible.
- **UI model:** ToolOps screens are backed by Core API payloads for command-center counts, correlation fields, timeline events, topology, narrative, policy simulation, integration verification, validation dashboard, story mode, and evidence bundle data.
- **Portfolio and story demos:** acceptance tests cover required event types, deterministic chaos fixture rows, replay status, redaction scans, integration overclaim scans, report and bundle artifacts, approved demo ports, and cleanup.

---

## Status and non-goals

ToolGuard here is a **demo-ready, local-first** implementation. The packages are private workspace packages at version `0.0.0`, and the strongest current evidence is the checked-in test suite plus deterministic demos.

**What it does claim:** a working protocol-independent core, MCP route, CLI wrapper, Python sidecar adapters, local observability UI, evidence reports and bundles, redaction, policy gates, replay fixtures, side-effect ledger, blast-radius scoring, retry-loop detection, topology, narrative, policy simulation, integration verification, guided story mode, validation dashboard, and validation coverage for those routed, wrapped, or supervised surfaces.

**What it does not claim:**

- Native interception of host tools that are not routed through ToolGuard.
- Production cloud integrations or credential-backed external services.
- npm or PyPI publication. Packages are workspace/private at `0.0.0`.

---

## License

No license file is present in this repository and no `license` field is declared in the package manifests, so licensing is **not specified**. Add a `LICENSE` file and a `license` field before any redistribution.
