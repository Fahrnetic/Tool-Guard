---
name: toolguard-readiness
description: Validate ToolGuard changes against the repository's agent-readiness workflow, safety rules, and package boundaries.
---

Use this skill when changing ToolGuard code, configs, or automation.

1. Identify the affected package.
2. Preserve package boundaries from `AGENTS.md`.
3. Run scoped tests while iterating.
4. Run `pnpm verify` before handoff.
5. Confirm generated files, secrets, and run artifacts are not staged.
