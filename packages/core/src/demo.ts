import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createChaosFixtures, registerChaosFixtures } from "./chaos-fixtures.js";
import { discoverDockerBridgeMetricsBindings } from "./docker-bridge.js";
import { createId } from "./ids.js";
import { collectToolGuardMetrics, renderPrometheusMetrics } from "./metrics.js";
import { exportToolGuardOtelDemo, sendToolGuardOtelPayloads } from "./otel-demo.js";
import { ToolRegistry } from "./registry.js";
import { redactString } from "./redaction.js";
import { createCoreApiServer } from "./server.js";
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
    await otelDemo({ send: false, serve: false });
    return;
  }
  if (command === "openobserve") {
    await otelDemo({ send: true, serve: true });
    return;
  }
  throw new Error(`Unknown demo command: ${command}`);
}

async function otelDemo(options: { readonly send: boolean; readonly serve: boolean }): Promise<void> {
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
  const sendResult = options.send ? await sendOtelWithGuidance(exported) : undefined;
  const metricsUrl = "http://127.0.0.1:3660/metrics";
  const openObserveUrl = "http://127.0.0.1:5080";
  const grafanaUrl = "http://127.0.0.1:33000/d/toolguard-observability/toolguard-observability";
  const prometheusUrl = "http://127.0.0.1:39090";
  const lokiUrl = "http://127.0.0.1:33100";

  console.log("ToolGuard OpenTelemetry demo");
  console.log("");
  console.log("Run");
  console.log("  deterministicSeed: toolguard-otel-demo-v0.1");
  console.log(`  runId: ${runId}`);
  console.log(`  evidenceDir: ${session.recorder.runDir}`);
  console.log(`  spanCount: ${exported.traces.spanCount}`);
  console.log("");
  console.log("Telemetry artifacts");
  console.log(`  traces: ${exported.tracePath}`);
  console.log(`  metrics: ${exported.metricsPath}`);
  console.log(`  logs: ${exported.logsPath}`);
  console.log(`  ndjsonLogs: ${exported.ndjsonLogsPath}`);
  console.log(`  dashboardQueries: ${exported.dashboardQueriesPath}`);
  console.log("");
  if (sendResult) printOtelSendResult(sendResult);
  console.log("Open");
  console.log(`  OpenObserve: ${openObserveUrl}`);
  console.log(`  Grafana: ${grafanaUrl}`);
  console.log(`  Prometheus: ${prometheusUrl}`);
  console.log(`  Loki: ${lokiUrl}`);
  console.log(`  Core metrics: ${metricsUrl}`);
  console.log("");
  console.log("Try these views");
  console.log("  1. Grafana dashboard: ToolGuard Observability");
  console.log(`  2. OpenObserve logs: run_id=${runId}`);
  console.log("  3. Prometheus query: toolguard_failures_total");
  console.log('  4. Loki query: {service_name="toolguard-local-demo"} | json');
  if (options.serve) {
    const listeners = await startOpenObserveDemoMetricsListeners({ root, session, registry });
    for (const listener of listeners) {
      console.log(`coreMetricsServer: listening on ${listener.url} (${listener.scope})`);
    }
    console.log("Press Ctrl+C to stop the demo metrics server.");
    await waitForShutdown(async () => {
      await Promise.all(listeners.map((listener) => listener.close()));
    });
  }
}

interface DemoMetricsListener {
  readonly url: string;
  readonly scope: string;
  close(): Promise<void>;
}

async function startOpenObserveDemoMetricsListeners(input: {
  readonly root: string;
  readonly session: CoreSession;
  readonly registry: ToolRegistry;
}): Promise<readonly DemoMetricsListener[]> {
  const loopbackHandle = createCoreApiServer({
    host: "127.0.0.1",
    port: 3660,
    evidenceRoot: input.root,
    session: input.session,
    registry: input.registry,
    seedDirectRun: false
  });
  await loopbackHandle.ready;
  const listeners: DemoMetricsListener[] = [
    {
      url: "http://127.0.0.1:3660",
      scope: "loopback API and metrics",
      close: loopbackHandle.close
    }
  ];

  const bridgeBindings = discoverDockerBridgeMetricsBindings();
  if (bridgeBindings.length === 0) {
    console.warn("coreMetricsServer: no Docker bridge gateway interface found; Prometheus host-gateway scrape may remain down on Linux.");
    return listeners;
  }

  for (const binding of bridgeBindings) {
    const bridgeListener = await startMetricsOnlyListener({
      host: binding.host,
      port: 3660,
      session: input.session,
      scope: `Docker bridge gateway metrics only via ${binding.interfaceName}`
    });
    listeners.push(bridgeListener);
  }

  return listeners;
}

async function startMetricsOnlyListener(input: {
  readonly host: string;
  readonly port: number;
  readonly session: CoreSession;
  readonly scope: string;
}): Promise<DemoMetricsListener> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${input.host}:${input.port}`);
    if (request.method === "GET" && url.pathname === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(`${renderPrometheusMetrics(collectToolGuardMetrics(input.session.recorder.events))}\n`);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, input.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    url: `http://${input.host}:${input.port}`,
    scope: input.scope,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function printOtelSendResult(sendResult: Awaited<ReturnType<typeof sendToolGuardOtelPayloads>>): void {
  const statuses = [sendResult.traces, sendResult.metrics, sendResult.logs].map((result) => `${result.signal}:${result.status}`).join(", ");
  console.log("Collector export");
  console.log(`  endpoint: ${sendResult.endpoint}`);
  console.log(`  postStatus: ${statuses}`);
  console.log("");
}

async function sendOtelWithGuidance(
  payloads: Awaited<ReturnType<typeof exportToolGuardOtelDemo>>
): Promise<Awaited<ReturnType<typeof sendToolGuardOtelPayloads>>> {
  try {
    return await sendToolGuardOtelPayloads({ payloads });
  } catch (error) {
    throw new Error(
      `Could not reach OTEL Collector at http://127.0.0.1:14318. Run pnpm observability:up, wait for OpenObserve and Collector to become ready, then retry. ${error instanceof Error ? error.message : String(error)}`
    );
  }
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

async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      close()
        .catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : String(error));
        })
        .finally(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
