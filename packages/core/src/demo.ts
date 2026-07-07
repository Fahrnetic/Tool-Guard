import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createChaosFixtures, registerChaosFixtures } from "./chaos-fixtures.js";
import { createId } from "./ids.js";
import { exportToolGuardOtelDemo } from "./otel-demo.js";
import { ToolRegistry } from "./registry.js";
import { redactString } from "./redaction.js";
import { CoreSession } from "./session.js";
import type { ToolCall } from "./types.js";

export const DEMO_FAILURE_SCENARIO = {
  scenarioId: "v0.1-core-malformed-json-baseline",
  fixtureId: "fixture.malformed-json",
  input: {}
} as const;
const TOOLPLANE_DEMO_RUN_ID = "run_demo_toolplane_seed_v011" as const;
const DEMO_SCENARIO_LIST = ["raw failure", "ToolGuard mediation", "report export", "manifest export"] as const;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "toolplane";
  if (command === "raw-failure") {
    await rawFailureDemo();
    return;
  }
  if (command === "toolplane") {
    await toolplaneDemo();
    return;
  }
  if (command === "otel") {
    await otelDemo();
    return;
  }
  throw new Error(`Unknown demo command: ${command}`);
}

async function otelDemo(): Promise<void> {
  const root = workspaceEvidenceRoot();
  const runId = "run_demo_otel_openobserve_seed_v001" as const;
  const session = new CoreSession({ evidenceRoot: root, runId, retry: { maxRetries: 1 } });
  const registry = new ToolRegistry();
  registerChaosFixtures(registry, { sandboxRoot: root });

  const malformed = registry.get("fixture.malformed-json");
  const destructive = registry.get("fixture.destructive-block");
  const injection = registry.get("fixture.prompt-injection-output");
  if (!malformed || !destructive || !injection) {
    throw new Error("ToolGuard OTEL demo fixtures are unavailable.");
  }

  await session.executeToolCall(registry, makeDemoCall(runId, malformed.downstreamServerId));
  await session.executeToolCall(
    registry,
    makeDemoCall(runId, destructive.downstreamServerId, {
      toolName: "fixture.destructive-block",
      idempotency: "non-idempotent"
    })
  );
  await session.executeToolCall(
    registry,
    makeDemoCall(runId, injection.downstreamServerId, {
      toolName: "fixture.prompt-injection-output",
      arguments: { message: "include a fake token and prompt injection output" }
    })
  );

  const exported = await exportToolGuardOtelDemo({
    events: session.recorder.events,
    outputDir: session.recorder.runDir,
    serviceName: "toolguard-local-demo"
  });
  const metricsUrl = "http://127.0.0.1:3660/metrics";
  const openObserveUrl = "http://127.0.0.1:5080";
  const grafanaUrl = "http://127.0.0.1:33000";

  console.log("ToolGuard OTEL and OpenObserve demo");
  console.log("deterministicSeed: toolguard-otel-demo-v0.1");
  console.log(`runId: ${runId}`);
  console.log(`evidenceDir: ${session.recorder.runDir}`);
  console.log(`otelTracesJson: ${exported.tracePath}`);
  console.log(`otelMetricsJson: ${exported.metricsPath}`);
  console.log(`otelLogsJson: ${exported.logsPath}`);
  console.log(`dashboardQueriesJson: ${exported.dashboardQueriesPath}`);
  console.log(`spanCount: ${exported.traces.spanCount}`);
  console.log(`openObserveUrl: ${openObserveUrl}`);
  console.log(`grafanaUrl: ${grafanaUrl}`);
  console.log(`prometheusScrapeTarget: ${metricsUrl}`);
  console.log("Start stack: docker compose -f observability/openobserve/docker-compose.yml up");
}

async function rawFailureDemo(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "toolguard-raw-demo-"));
  const fixture = createChaosFixtures({ sandboxRoot: root }).find((tool) => tool.toolName === DEMO_FAILURE_SCENARIO.fixtureId);
  if (!fixture) {
    throw new Error("Raw failure fixture is unavailable.");
  }

  console.log("ToolGuard raw failure demo");
  console.log("deterministicSeed: toolguard-core-demo-v0.11");
  console.log(`scenarioList: ${DEMO_SCENARIO_LIST.join(" -> ")}`);
  console.log(`fixtureId: ${DEMO_FAILURE_SCENARIO.fixtureId}`);
  console.log(`scenarioId: ${DEMO_FAILURE_SCENARIO.scenarioId}`);
  console.log(`input: ${JSON.stringify(DEMO_FAILURE_SCENARIO.input)}`);
  console.log("Mediation: disabled");
  try {
    await fixture.execute({ signal: new AbortController().signal, call: makeDemoCall(createId("run"), fixture.downstreamServerId) });
  } catch (error) {
    console.log("Raw downstream failure:");
    console.log(error instanceof Error ? error.message : String(error));
    console.log("No Failure Card, no recovery guidance, no redaction summary.");
    return;
  }
  throw new Error("Expected deterministic raw fixture failure.");
}

async function toolplaneDemo(): Promise<void> {
  const root = workspaceEvidenceRoot();
  const runId = TOOLPLANE_DEMO_RUN_ID;
  const session = new CoreSession({ evidenceRoot: root, runId, retry: { maxRetries: 1 } });
  const registry = new ToolRegistry();
  registerChaosFixtures(registry, { sandboxRoot: root });
  const tool = registry.get(DEMO_FAILURE_SCENARIO.fixtureId);
  if (!tool) {
    throw new Error("ToolGuard demo fixture is unavailable.");
  }

  const result = await session.executeToolCall(registry, makeDemoCall(runId, tool.downstreamServerId));
  const report = await session.exportReport();

  console.log("ToolGuard mediated failure demo");
  console.log("deterministicSeed: toolguard-core-demo-v0.11");
  console.log(`scenarioList: ${DEMO_SCENARIO_LIST.join(" -> ")}`);
  console.log(`fixtureId: ${DEMO_FAILURE_SCENARIO.fixtureId}`);
  console.log(`scenarioId: ${DEMO_FAILURE_SCENARIO.scenarioId}`);
  console.log(`input: ${JSON.stringify(DEMO_FAILURE_SCENARIO.input)}`);
  console.log(`runId: ${runId}`);
  console.log(`evidenceDir: ${session.recorder.runDir}`);
  console.log(`eventsJsonl: ${session.recorder.eventsPath}`);
  console.log(`reportHtml: ${report.reportPath}`);
  console.log(`manifestJson: ${report.manifestPath}`);
  if ("failureType" in result) {
    console.log("Failure Card:");
    console.log(`  toolName: ${result.toolName}`);
    console.log(`  failureType: ${result.failureType}`);
    console.log(`  retryable: ${result.retryable}`);
    console.log(`  doNotRetrySameCall: ${result.doNotRetrySameCall}`);
    console.log(`  safeSummary: ${redactString(result.safeSummary)}`);
    console.log(`  evidenceArtifacts: ${result.evidenceLinks.map((link) => link.artifactId).join(", ")}`);
  } else {
    console.log(`Result: ${redactString(result.safeSummary)}`);
  }
}

export function makeDemoCall(
  runId: ToolCall["runId"],
  downstreamServerId: ToolCall["downstreamServerId"],
  overrides: Partial<ToolCall> = {}
): ToolCall {
  return {
    runId,
    traceId: createId("trace"),
    parentId: createId("parent"),
    harnessId: createId("harness"),
    adapterId: createId("adapter"),
    downstreamServerId,
    toolCallId: createId("toolcall"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName: DEMO_FAILURE_SCENARIO.fixtureId,
    arguments: DEMO_FAILURE_SCENARIO.input,
    deadlineMs: 100,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    ...overrides
  };
}

function workspaceEvidenceRoot(): string {
  if (process.env.TOOLGUARD_EVIDENCE_ROOT) return process.env.TOOLGUARD_EVIDENCE_ROOT;
  return path.basename(process.cwd()) === "core" && path.basename(path.dirname(process.cwd())) === "packages"
    ? path.resolve(process.cwd(), "../..", "runs")
    : path.join(process.cwd(), "runs");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
