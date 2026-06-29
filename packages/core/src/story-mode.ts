import type { JsonObject } from "./types.js";

export type DemoStoryScenarioId =
  | "raw-failure"
  | "prompt-injection"
  | "destructive-fixture-block"
  | "retry-loop-containment"
  | "malformed-mcp-response"
  | "cli-non-zero-exit"
  | "python-sidecar-unavailable";

export type DemoStoryStageId =
  | "run-raw"
  | "run-through-toolguard"
  | "inspect-topology"
  | "simulate-policy"
  | "export-evidence";

export interface DemoStoryStage {
  readonly id: DemoStoryStageId;
  readonly label: string;
  readonly narrative: string;
  readonly expectedOutcome: string;
}

export interface DemoStoryComparison {
  readonly raw: DemoStoryComparisonSide;
  readonly mediated: DemoStoryComparisonSide;
  readonly sameFixtureProof: string;
}

export interface DemoStoryComparisonSide {
  readonly path: "raw" | "toolguard";
  readonly fixtureId: string;
  readonly scenarioInput: JsonObject;
  readonly failureType: string;
  readonly safeSummary: string;
  readonly retryBehavior: string;
  readonly blastRadiusScore: number;
  readonly sideEffects: string;
  readonly evidenceAvailability: string;
  readonly recoveryGuidance: string;
}

export interface DemoStoryScenario {
  readonly id: DemoStoryScenarioId;
  readonly label: string;
  readonly stableLabel: string;
  readonly fixtureId: string;
  readonly scenarioSeed: string;
  readonly scenarioInput: JsonObject;
  readonly route: "fixture-only" | "loopback-only";
  readonly fixtureOnly: true;
  readonly loopbackOnly: true;
  readonly deterministicOutcome: string;
  readonly cleanup: {
    readonly afterScenario: string;
    readonly onExit: string;
    readonly ownedPorts: readonly number[];
  };
  readonly resetControl: {
    readonly label: string;
    readonly endpoint: "/api/story/reset";
    readonly method: "POST";
  };
  readonly comparison: DemoStoryComparison;
}

export interface DemoStoryModePayload {
  readonly generatedAt: string;
  readonly deterministicSeed: string;
  readonly serveCommand: "pnpm demo:serve";
  readonly stageOrder: readonly DemoStoryStage[];
  readonly scenarios: readonly DemoStoryScenario[];
  readonly processHygiene: {
    readonly approvedPorts: readonly number[];
    readonly startSurfaces: readonly string[];
    readonly cleanupOnScenarioReset: string;
    readonly cleanupOnExit: string;
    readonly noExternalServices: true;
  };
}

export interface DemoStoryScenarioProcessHandle {
  readonly pid?: number;
  close(): Promise<void> | void;
}

export interface DemoStoryFixtureResetTarget {
  readonly port: number;
  reset(scenario: DemoStoryScenario): Promise<void> | void;
}

export interface DemoStoryScenarioResetResult {
  readonly ok: true;
  readonly scenarioId: DemoStoryScenarioId;
  readonly stableLabel: string;
  readonly deterministicOutcome: string;
  readonly cleanup: DemoStoryScenario["cleanup"];
  readonly resetAt: string;
  readonly resetSequence: number;
  readonly fixtureState: {
    readonly reset: true;
    readonly fixtureId: string;
    readonly scenarioSeed: string;
    readonly resetCount: number;
  };
  readonly processCleanup: {
    readonly scenarioOwnedProcessesClosed: number;
    readonly closedPids: readonly number[];
    readonly errors: readonly string[];
  };
  readonly fixtureStack: {
    readonly resetTargets: readonly number[];
    readonly resetCount: number;
    readonly errors: readonly string[];
  };
}

export class DemoStoryScenarioRuntime {
  readonly #processes = new Map<DemoStoryScenarioId, Set<DemoStoryScenarioProcessHandle>>();
  readonly #resetCounts = new Map<DemoStoryScenarioId, number>();
  readonly #resetTargets: readonly DemoStoryFixtureResetTarget[];
  #sequence = 0;

  constructor(options: { readonly resetTargets?: readonly DemoStoryFixtureResetTarget[] } = {}) {
    this.#resetTargets = options.resetTargets ?? [];
  }

  registerScenarioProcess(scenarioId: DemoStoryScenarioId, handle: DemoStoryScenarioProcessHandle): void {
    const scenario = DEMO_STORY_SCENARIOS.find((candidate) => candidate.id === scenarioId);
    if (!scenario) {
      throw new Error(`Unknown demo story scenario: ${scenarioId}`);
    }
    const handles = this.#processes.get(scenarioId) ?? new Set<DemoStoryScenarioProcessHandle>();
    handles.add(handle);
    this.#processes.set(scenarioId, handles);
  }

  async resetScenario(
    scenarioId: DemoStoryScenarioId
  ): Promise<DemoStoryScenarioResetResult | { readonly ok: false; readonly error: "unknown_story_scenario"; readonly scenarioId: string }> {
    const scenario = DEMO_STORY_SCENARIOS.find((candidate) => candidate.id === scenarioId);
    if (!scenario) {
      return { ok: false, error: "unknown_story_scenario", scenarioId };
    }

    const processCleanup = await this.#closeScenarioProcesses(scenarioId);
    const fixtureStack = await this.#resetFixtureStack(scenario);
    const resetCount = (this.#resetCounts.get(scenarioId) ?? 0) + 1;
    this.#resetCounts.set(scenarioId, resetCount);
    this.#sequence += 1;

    return {
      ok: true,
      scenarioId,
      stableLabel: scenario.stableLabel,
      deterministicOutcome: scenario.deterministicOutcome,
      cleanup: scenario.cleanup,
      resetAt: new Date().toISOString(),
      resetSequence: this.#sequence,
      fixtureState: {
        reset: true,
        fixtureId: scenario.fixtureId,
        scenarioSeed: scenario.scenarioSeed,
        resetCount
      },
      processCleanup,
      fixtureStack
    };
  }

  async closeAll(): Promise<void> {
    const scenarioIds = [...this.#processes.keys()];
    await Promise.all(scenarioIds.map((scenarioId) => this.#closeScenarioProcesses(scenarioId)));
  }

  async #closeScenarioProcesses(scenarioId: DemoStoryScenarioId): Promise<DemoStoryScenarioResetResult["processCleanup"]> {
    const handles = this.#processes.get(scenarioId) ?? new Set<DemoStoryScenarioProcessHandle>();
    this.#processes.delete(scenarioId);
    const closedPids: number[] = [];
    const errors: string[] = [];
    for (const handle of handles) {
      try {
        await handle.close();
        if (typeof handle.pid === "number") {
          closedPids.push(handle.pid);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return {
      scenarioOwnedProcessesClosed: handles.size,
      closedPids,
      errors
    };
  }

  async #resetFixtureStack(scenario: DemoStoryScenario): Promise<DemoStoryScenarioResetResult["fixtureStack"]> {
    const errors: string[] = [];
    for (const target of this.#resetTargets) {
      try {
        await target.reset(scenario);
      } catch (error) {
        errors.push(`port ${target.port}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      resetTargets: this.#resetTargets.map((target) => target.port),
      resetCount: this.#resetTargets.length - errors.length,
      errors
    };
  }
}

export const defaultDemoStoryScenarioRuntime = new DemoStoryScenarioRuntime();

export const DEMO_STORY_STAGE_ORDER: readonly DemoStoryStage[] = [
  {
    id: "run-raw",
    label: "Run raw",
    narrative: "Run the deterministic fixture directly to show the baseline failure without ToolGuard mediation.",
    expectedOutcome: "Raw output shows the failure mode with no Failure Card, policy decision, topology, or evidence export."
  },
  {
    id: "run-through-toolguard",
    label: "Run through ToolGuard",
    narrative: "Run the same fixture, seed, and input through ToolGuard so classification, redaction, policy, and evidence are applied.",
    expectedOutcome: "ToolGuard returns a model-safe result or Failure Card with raw details separated."
  },
  {
    id: "inspect-topology",
    label: "Inspect topology",
    narrative: "Inspect the failure topology and run narrative derived from Core events plus the side-effect ledger.",
    expectedOutcome: "Topology highlights harness, adapter, downstream, policy, attempt, side-effect, artifact, and report nodes."
  },
  {
    id: "simulate-policy",
    label: "Simulate policy",
    narrative: "Dry-run policy changes against recorded local scenario data without executing downstream side effects.",
    expectedOutcome: "Policy simulation previews allow, block, retry, fail-fast, open circuit, and close circuit outcomes where applicable."
  },
  {
    id: "export-evidence",
    label: "Export evidence",
    narrative: "Export local evidence and reports for review, with secret-shaped values redacted from user-visible output.",
    expectedOutcome: "Report, manifest, artifact hashes, redaction summary, topology, and simulation receipts are linked through loopback routes."
  }
];

export const DEMO_STORY_SCENARIOS: readonly DemoStoryScenario[] = [
  makeScenario({
    id: "raw-failure",
    label: "Raw failure baseline",
    fixtureId: "fixture.malformed-json",
    scenarioSeed: "story-seed-001",
    deterministicOutcome: "Malformed JSON is exposed as an unclassified raw failure before ToolGuard mediates it.",
    failureType: "malformed_json",
    rawSummary: "Raw path receives an unterminated fixture payload and stops without model-safe guidance.",
    mediatedSummary: "ToolGuard classifies malformed_json, stores the raw payload separately, and points to recovery guidance.",
    retryBehavior: "Do not retry the same malformed call. Repair the downstream protocol payload first.",
    blastRadiusScore: 18,
    sideEffects: "No real side effects, only a fixture protocol failure."
  }),
  makeScenario({
    id: "prompt-injection",
    label: "Prompt injection containment",
    fixtureId: "fixture.prompt-injection-output",
    scenarioSeed: "story-seed-002",
    deterministicOutcome: "Suspicious instruction-like fixture output is sanitized before it reaches model-facing summaries.",
    failureType: "prompt_injection_output",
    rawSummary: "Raw path displays suspicious instruction-like output from a local fixture.",
    mediatedSummary: "ToolGuard emits output.sanitized and returns a safe summary with raw content separated.",
    retryBehavior: "Do not retry unchanged output. Inspect separated evidence and repair the downstream tool.",
    blastRadiusScore: 35,
    sideEffects: "No mutation. The unsafe content is contained as fixture-only raw evidence."
  }),
  makeScenario({
    id: "destructive-fixture-block",
    label: "Destructive fixture block",
    fixtureId: "fixture.destructive-block",
    scenarioSeed: "story-seed-003",
    deterministicOutcome: "A high-risk action is blocked or simulated in the fixture sandbox before any workspace mutation.",
    failureType: "destructive_action_blocked",
    rawSummary: "Raw path shows the destructive intent as fixture text only, never as a real command.",
    mediatedSummary: "ToolGuard policy blocks the destructive fixture and records a blocked side-effect ledger row.",
    retryBehavior: "Same-call retry suppressed unless the action remains explicitly fixture-only.",
    blastRadiusScore: 62,
    sideEffects: "Blocked fixture filesystem effect. No files outside the sandbox are touched."
  }),
  makeScenario({
    id: "retry-loop-containment",
    label: "Retry-loop containment",
    fixtureId: "fixture.crash-after-initialize",
    scenarioSeed: "story-seed-004",
    deterministicOutcome: "Repeated deterministic crashes open a scoped circuit and fast-fail subsequent same-target attempts.",
    failureType: "circuit_open",
    rawSummary: "Raw path repeats the same crash with no loop explanation.",
    mediatedSummary: "ToolGuard detects repeated failures, opens the circuit, and explains why retrying is no longer recovery.",
    retryBehavior: "Bounded retries only, then circuit-open fast-fail for the affected downstream target.",
    blastRadiusScore: 44,
    sideEffects: "No mutation. Process risk stays contained to the fixture target."
  }),
  makeScenario({
    id: "malformed-mcp-response",
    label: "Malformed MCP response",
    fixtureId: "fixture.mcp-malformed-response",
    scenarioSeed: "story-seed-005",
    deterministicOutcome: "A loopback MCP fixture returns malformed protocol data and the adapter stays healthy.",
    failureType: "malformed_json",
    rawSummary: "Raw MCP path surfaces malformed protocol data without a stable Failure Card.",
    mediatedSummary: "ToolGuard MCP routing classifies the protocol failure and preserves correlation IDs.",
    retryBehavior: "Do not retry the same malformed MCP response. Fix or replace the downstream server.",
    blastRadiusScore: 28,
    sideEffects: "Loopback-only protocol failure. No external network calls."
  }),
  makeScenario({
    id: "cli-non-zero-exit",
    label: "CLI non-zero exit",
    fixtureId: "fixture.cli-non-zero",
    scenarioSeed: "story-seed-006",
    deterministicOutcome: "A local fixture process exits non-zero and ToolGuard captures stdout, stderr, and exit status.",
    failureType: "non_zero_exit",
    rawSummary: "Raw process path returns a non-zero exit without normalized ToolGuard evidence.",
    mediatedSummary: "ToolGuard CLI supervision classifies non_zero_exit and redacts process streams before display.",
    retryBehavior: "Retry only after command arguments or fixture state change.",
    blastRadiusScore: 31,
    sideEffects: "Loopback process fixture only. No shell expansion or destructive command."
  }),
  makeScenario({
    id: "python-sidecar-unavailable",
    label: "Python sidecar unavailable",
    fixtureId: "fixture.python-sidecar-unavailable",
    scenarioSeed: "story-seed-007",
    deterministicOutcome: "Python adapters fail closed when the local sidecar endpoint is unavailable.",
    failureType: "sidecar_unavailable",
    rawSummary: "Raw framework path cannot reach the sidecar and has no direct ToolGuard fallback.",
    mediatedSummary: "ToolGuard adapter returns a classified fail-closed Failure Card instead of unguarded execution.",
    retryBehavior: "Restart the loopback sidecar before retrying. Do not fall back to direct tool execution.",
    blastRadiusScore: 22,
    sideEffects: "No downstream execution occurred because the local sidecar was unavailable."
  })
];

export function buildDemoStoryModePayload(): DemoStoryModePayload {
  return {
    generatedAt: new Date(0).toISOString(),
    deterministicSeed: "toolguard-story-mode-v0.9",
    serveCommand: "pnpm demo:serve",
    stageOrder: DEMO_STORY_STAGE_ORDER,
    scenarios: DEMO_STORY_SCENARIOS,
    processHygiene: {
      approvedPorts: [3660, 3661, 3662, 3663, 3664],
      startSurfaces: [
        "Core/API/SSE on http://127.0.0.1:3660",
        "UI on http://127.0.0.1:3661",
        "Fixture stack is in-process or loopback-only on approved ports 3662-3664"
      ],
      cleanupOnScenarioReset: "Reset uses deterministic fixture IDs, resets the fixture stack, and clears only ToolGuard-owned scenario state.",
      cleanupOnExit: "demo:serve traps SIGINT/SIGTERM and closes Core/API, the owned UI child process by PID, and fixture stack handles.",
      noExternalServices: true
    }
  };
}

export function resetDemoStoryScenario(
  scenarioId: DemoStoryScenarioId
): Promise<DemoStoryScenarioResetResult | { readonly ok: false; readonly error: "unknown_story_scenario"; readonly scenarioId: string }> {
  return defaultDemoStoryScenarioRuntime.resetScenario(scenarioId);
}

function makeScenario(input: {
  readonly id: DemoStoryScenarioId;
  readonly label: string;
  readonly fixtureId: string;
  readonly scenarioSeed: string;
  readonly deterministicOutcome: string;
  readonly failureType: string;
  readonly rawSummary: string;
  readonly mediatedSummary: string;
  readonly retryBehavior: string;
  readonly blastRadiusScore: number;
  readonly sideEffects: string;
}): DemoStoryScenario {
  const scenarioInput = { seed: input.scenarioSeed, fixtureId: input.fixtureId, mode: "deterministic" };
  return {
    id: input.id,
    label: input.label,
    stableLabel: `${input.id}:${input.fixtureId}:${input.scenarioSeed}`,
    fixtureId: input.fixtureId,
    scenarioSeed: input.scenarioSeed,
    scenarioInput,
    route: input.id === "malformed-mcp-response" || input.id === "cli-non-zero-exit" || input.id === "python-sidecar-unavailable"
      ? "loopback-only"
      : "fixture-only",
    fixtureOnly: true,
    loopbackOnly: true,
    deterministicOutcome: input.deterministicOutcome,
    cleanup: {
      afterScenario: `Reset ${input.fixtureId} deterministic state and close any scenario-owned process handles.`,
      onExit: "Close Core/API, UI child process, and fixture stack loopback handles started by demo:serve.",
      ownedPorts: [3660, 3661, 3662, 3663, 3664]
    },
    resetControl: {
      label: `Reset ${input.label}`,
      endpoint: "/api/story/reset",
      method: "POST"
    },
    comparison: {
      sameFixtureProof: `Raw and ToolGuard paths both use ${input.fixtureId} with seed ${input.scenarioSeed}.`,
      raw: {
        path: "raw",
        fixtureId: input.fixtureId,
        scenarioInput,
        failureType: input.failureType,
        safeSummary: input.rawSummary,
        retryBehavior: "No bounded ToolGuard retry guidance on the raw path.",
        blastRadiusScore: Math.min(100, input.blastRadiusScore + 12),
        sideEffects: input.sideEffects,
        evidenceAvailability: "Raw transcript only, no correlated ToolGuard evidence bundle.",
        recoveryGuidance: "Manual inspection required."
      },
      mediated: {
        path: "toolguard",
        fixtureId: input.fixtureId,
        scenarioInput,
        failureType: input.failureType,
        safeSummary: input.mediatedSummary,
        retryBehavior: input.retryBehavior,
        blastRadiusScore: input.blastRadiusScore,
        sideEffects: input.sideEffects,
        evidenceAvailability: "Failure Card, topology, ledger row, report, and manifest are available on loopback routes.",
        recoveryGuidance: "Follow the Failure Card recovery guidance and inspect separated raw evidence only when needed."
      }
    }
  };
}
