# Agent Instructions

## Project map

- `packages/core`: protocol-independent ToolGuard runtime, event model, redaction, evidence, reports, topology, and local Core API.
- `packages/cli`: `toolplane` and `toolguard` process wrapper CLI.
- `packages/mcp-adapter`: MCP proxy/router, demos, story-mode server, and integration snippets.
- `packages/python-adapters`: thin Python adapters for LangGraph and CrewAI.
- `packages/ui`: Vite/React local observability UI.

Shared code belongs in `packages/core`. UI code must not import MCP, CLI, or Python adapter internals.

## Setup

Requirements:

- Node.js `>=22`
- pnpm `10.25.0`
- Python `>=3.10`

Fresh clone setup:

```bash
pnpm install
pnpm verify
```

## Validation commands

- Format check: `pnpm format:check`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Unit tests: `pnpm test`
- Coverage: `pnpm test:coverage`
- Build: `pnpm build`
- Full local gate: `pnpm verify`

Run package-scoped commands with `pnpm --filter <package> <script>` when iterating.

## Naming conventions

- Use `camelCase` for variables, functions, and object properties.
- Use `PascalCase` for React components, classes, and exported TypeScript types.
- Use `UPPER_SNAKE_CASE` only for process-wide constants.
- Use kebab-case for package names and route labels.
- Test files must be named `*.test.ts`, `*.test.tsx`, or `test_*.py`.

## Safety rules

- Do not commit generated `dist`, `coverage`, `runs`, `.env`, or cache files.
- Keep demos local-first and loopback-only unless a task explicitly changes deployment behavior.
- Preserve redaction before model-facing output. Raw artifacts may exist only in evidence paths.
- Do not relax destructive command guards, output budgets, or trace correlation without adding tests.
- Check `monitoring/alerts.yml`, `monitoring/deployment-observability.yml`, and `runbooks/incident-response.md` before changing health, metrics, or release behavior.
- Use `observability/openobserve/docker-compose.yml` for local OpenObserve, OpenTelemetry Collector, Prometheus, Grafana, and Loki demos.
- Use `docs/api/openapi.yaml` when changing local Core API routes.

## Repository governance

- Main branch protection is defined as code in `.github/rulesets/main-branch-protection.json` and checked by `scripts/check-branch-protection.mjs`.
- Backlog health policy is defined in `backlog-health.config.json` and enforced by `.github/workflows/backlog-health.yml`.
- Update governance checks with any change to required status checks, issue labels, or backlog SLAs.

## Expected workflow

1. Inspect the relevant package and tests.
2. Make the smallest change that preserves package boundaries.
3. Add or update tests for behavior changes.
4. Run scoped validation while iterating.
5. Run `pnpm verify` before handing off.
