import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { runToolplaneCli } from "@toolplane/cli";
import {
  ClassifiedToolError,
  createId,
  registerChaosFixtures,
  type CoreEvent,
  type ToolCall
} from "@toolplane/core";
import { createMcpAdapterDemoApiServer, type McpAdapterDemoApiServerHandle } from "./demo.js";

const CORE_URL = "http://127.0.0.1:3660";
const UI_URL = "http://127.0.0.1:3661";
const APPROVED_PORTS = "3660-3669";
const FLAGSHIP_DEMO_SEED = "toolguard-flagship-demo-v0.11";
const FLAGSHIP_DEMO_RUN_ID = "run_demo_flagship_seed_v011";
const FLAGSHIP_SCENARIO_LIST = [
  "raw failure",
  "ToolGuard mediation",
  "topology map",
  "policy simulation",
  "integration verification",
  "evidence bundle export"
] as const;
const execFile = promisify(execFileCallback);
const REQUIRED_CHAOS_FIXTURES = [
  "fixture.good",
  "fixture.wrong-cwd",
  "fixture.slow",
  "fixture.hanging-stream",
  "fixture.crash-after-initialize",
  "fixture.malformed-json",
  "fixture.prompt-injection-output"
] as const;

export interface PortfolioDemoOptions {
  readonly holdMs?: number;
  readonly startUi?: boolean;
}

export interface PortfolioDemoResult {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly coreUrl: string;
  readonly uiUrl?: string;
  readonly reportHtml?: string;
  readonly manifestJson?: string;
  readonly eventCount: number;
  readonly failureCount: number;
  readonly preflightStatuses: readonly string[];
  readonly chaosFixtureRows: readonly string[];
  readonly requiredEventTypes: readonly string[];
  readonly replayStatus: string;
  readonly redactionScanPassed: boolean;
  readonly noOverclaimScanPassed: boolean;
  readonly cleanupVerified: boolean;
  readonly integrationClaimLevels: readonly string[];
  readonly scenarioList: readonly string[];
  readonly evidenceBundleManifest?: string;
  readonly transcript: string;
}

export async function runPortfolioDemo(options: PortfolioDemoOptions = {}): Promise<PortfolioDemoResult> {
  const startUi = options.startUi ?? true;
  const holdMs = options.holdMs ?? 1_500;
  let handle: McpAdapterDemoApiServerHandle | undefined;
  let ui: ChildProcess | undefined;
  let result: Omit<PortfolioDemoResult, "cleanupVerified" | "transcript"> & { readonly transcriptLines: readonly string[] } | undefined;
  const transcript: string[] = [
    "ToolGuard portfolio demo",
    `deterministicSeed: ${FLAGSHIP_DEMO_SEED}`,
    `scenarioList: ${FLAGSHIP_SCENARIO_LIST.join(" -> ")}`,
    `approvedPorts: ${APPROVED_PORTS}`,
    `coreApi: ${CORE_URL}`
  ];
  assertApprovedPorts([3660, ...(startUi ? [3661] : [])]);

  try {
    const repoRoot = process.env.INIT_CWD ?? path.resolve(new URL("../../..", import.meta.url).pathname);
    const evidenceRoot = path.join(repoRoot, "runs");
    const deterministicRunDir = path.join(evidenceRoot, FLAGSHIP_DEMO_RUN_ID);
    await rm(deterministicRunDir, { recursive: true, force: true });
    transcript.push(`fixtureReset: cleared deterministic run directory ${deterministicRunDir}`);

    handle = await createMcpAdapterDemoApiServer({
      host: "127.0.0.1",
      port: 3660,
      evidenceRoot,
      runId: FLAGSHIP_DEMO_RUN_ID
    });
    await assertJson(`${CORE_URL}/health`, "Core/API health");
    const finalAcceptanceTranscript = await exercisePortfolioAcceptanceSurfaces(handle);
    const topology = await assertJson<{ readonly nodes: readonly unknown[]; readonly edges: readonly unknown[] }>(
      `${CORE_URL}/api/topology/latest`,
      "topology map"
    );
    const narrative = await assertJson<{ readonly text: string }>(`${CORE_URL}/api/narrative/latest`, "run health narrative");
    const simulation = await postJson<{ readonly previewDecisions: readonly unknown[]; readonly evidenceLinks: readonly unknown[] }>(
      `${CORE_URL}/api/policy/simulate`,
      { scenarioId: "retry-loop-failure", proposedPolicy: { retryLimit: 1, timeoutMs: 250 } },
      "policy simulation"
    );
    const verification = await postJson<{ readonly routeType: string; readonly evidenceLinks: readonly unknown[] }>(
      `${CORE_URL}/api/integrations/verify`,
      { routeType: "mcp-routed" },
      "integration verification"
    );
    const replay = await assertJson<{ readonly replayableRuns: readonly unknown[] }>(`${CORE_URL}/api/replay`, "replay metadata");
    const replayResult = await postJson<{ readonly status: string }>(
      `${CORE_URL}/api/replay`,
      { toolName: "fixture.prompt-injection-output", fixtureOnly: true },
      "fixture replay"
    );
    const report = await assertJson<{
      readonly reportHtml: string;
      readonly manifestJson: string;
      readonly redactionSummary: string;
      readonly manifestValid: boolean;
      readonly validationErrors: readonly string[];
    }>(`${CORE_URL}/api/reports/export`, "report export");
    if (!report.manifestValid) {
      throw new Error(`Portfolio demo report manifest did not validate: ${report.validationErrors.join("; ")}`);
    }
    const bundle = await postJson<{
      readonly manifestJson: string;
      readonly manifestUrl: string;
      readonly manifestValid: boolean;
      readonly validationErrors: readonly string[];
    }>(
      `${CORE_URL}/api/bundle/export`,
      { replaySafety: { fixtureOnly: true, safeLoopback: true } },
      "evidence bundle export"
    );
    if (!bundle.manifestValid) {
      throw new Error(`Evidence bundle manifest did not validate: ${bundle.validationErrors.join("; ")}`);
    }

    if (startUi) {
      ui = startUiDevServer();
      await assertHttpOk(UI_URL, "UI");
      transcript.push(`ui: ${UI_URL}`);
    }

    const latest = await assertJson<{ readonly eventCount: number; readonly events: readonly CoreEvent[] }>(`${CORE_URL}/api/runs/latest`, "latest run");
    const health = await assertJson<{
      readonly rows: readonly { readonly name: string; readonly status: string }[];
    }>(`${CORE_URL}/api/health`, "preflight matrix");
    const failures = await assertJson<{ readonly failures: readonly unknown[] }>(`${CORE_URL}/api/failures`, "failures");
    const integrations = await assertJson<{
      readonly integrations: readonly { readonly name: string; readonly route: string; readonly claimLevel: string; readonly limitation: string }[];
    }>(`${CORE_URL}/api/integrations`, "integration claim audit");
    const reports = await assertJson<{
      readonly reports: readonly { readonly reportUrl: string; readonly manifestUrl: string; readonly redactionSummaryUrl: string }[];
    }>(`${CORE_URL}/api/reports`, "report listings");
    const reportText = await readFile(report.reportHtml, "utf8");
    const manifestText = await readFile(report.manifestJson, "utf8");
    const redactionSummaryText = await readFile(report.redactionSummary, "utf8");
    const ledgerText = await readFile(path.join(handle.result.evidenceDir, "ledger.jsonl"), "utf8");
    const topologyText = await readFile(path.join(handle.result.evidenceDir, "topology.json"), "utf8");
    const narrativeText = await readFile(path.join(handle.result.evidenceDir, "narrative.json"), "utf8");
    const bundleManifestText = await readFile(bundle.manifestJson, "utf8");
    const storyText = JSON.stringify(await assertJson<unknown>(`${CORE_URL}/api/story`, "story mode payload"));
    const userVisibleText = [
      handle.result.transcript,
      JSON.stringify(latest.events),
      JSON.stringify(failures),
      JSON.stringify(integrations),
      reportText,
      manifestText,
      redactionSummaryText,
      ledgerText,
      topologyText,
      narrativeText,
      bundleManifestText,
      storyText
    ].join("\n");
    assertNoSecrets(userVisibleText);
    assertNoUnsupportedOverclaims(userVisibleText);

    const requiredEventTypes = requiredEventsSeen(latest.events);
    const chaosFixtureRows = REQUIRED_CHAOS_FIXTURES.map((fixture) => {
      const row = health.rows.find((candidate) => candidate.name === fixture || candidate.name.includes(fixture));
      if (!row) {
        throw new Error(`Preflight matrix is missing required deterministic chaos fixture row: ${fixture}`);
      }
      return `${fixture}:${row.status}`;
    });

    transcript.push(
      handle.result.transcript,
      finalAcceptanceTranscript,
      `runId: ${handle.result.runId}`,
      `evidenceDir: ${handle.result.evidenceDir}`,
      `reportHtml: ${report.reportHtml}`,
      `manifestJson: ${report.manifestJson}`,
      `bundleManifestJson: ${bundle.manifestJson}`,
      `redactionSummary: ${report.redactionSummary}`,
      `topologyMap: nodes=${topology.nodes.length} edges=${topology.edges.length}`,
      `runHealthNarrative: ${narrative.text.split(/\r?\n/)[0] ?? "generated"}`,
      `policySimulation: decisions=${simulation.previewDecisions.length} evidenceLinks=${simulation.evidenceLinks.length}`,
      `integrationVerification: route=${verification.routeType} evidenceLinks=${verification.evidenceLinks.length}`,
      `replayableRuns: ${replay.replayableRuns.length}`,
      `replayStatus: ${replayResult.status}`,
      `eventCount: ${latest.eventCount}`,
      `failureCards: ${failures.failures.length}`,
      `requiredEvents: ${requiredEventTypes.join(", ")}`,
      `redactionScan: passed`,
      `integrationOverclaimScan: passed`,
      "preflight matrix:",
      ...health.rows.map((row) => `  - ${row.status}: ${row.name}`),
      "deterministic chaos fixture rows:",
      ...chaosFixtureRows.map((row) => `  - ${row}`),
      "integration claim-level audit:",
      ...integrations.integrations.map(
        (integration) =>
          `  - ${integration.name}: ${integration.route}, ${integration.claimLevel}; ${integration.limitation}`
      ),
      "report/replay links:",
      ...reports.reports.map((entry) => `  - ${entry.reportUrl} | ${entry.manifestUrl} | ${entry.redactionSummaryUrl}`)
    );

    if (holdMs > 0) {
      transcript.push(`holdMs: ${holdMs}`);
      await delay(holdMs);
    }

    result = {
      runId: handle.result.runId,
      evidenceDir: handle.result.evidenceDir,
      coreUrl: CORE_URL,
      ...(startUi ? { uiUrl: UI_URL } : {}),
      reportHtml: report.reportHtml,
      manifestJson: report.manifestJson,
      eventCount: latest.eventCount,
      failureCount: failures.failures.length,
      preflightStatuses: health.rows.map((row) => `${row.name}:${row.status}`),
      chaosFixtureRows,
      requiredEventTypes,
      replayStatus: replayResult.status,
      redactionScanPassed: true,
      noOverclaimScanPassed: true,
      integrationClaimLevels: integrations.integrations.map(
        (integration) => `${integration.name}:${integration.route}:${integration.claimLevel}`
      ),
      scenarioList: FLAGSHIP_SCENARIO_LIST,
      evidenceBundleManifest: bundle.manifestJson,
      transcriptLines: transcript
    };
  } finally {
    if (ui) {
      await stopChild(ui);
    }
    if (handle) {
      await handle.close();
    }
  }
  if (!result) {
    throw new Error("Portfolio demo did not produce a result before cleanup.");
  }
  const cleanupProbe = await verifyOwnedCleanup({
    ports: startUi ? [3660, 3661] : [3660],
    pids: ui?.pid ? [ui.pid] : []
  });
  if (!cleanupProbe.verified) {
    throw new Error(`ToolGuard-owned cleanup probe failed: ${cleanupProbe.failures.join("; ")}`);
  }
  const transcriptWithCleanup = [
    ...result.transcriptLines,
    `cleanupProbe: portsClosed=${cleanupProbe.closedPorts.join(",") || "none"} pidsExited=${cleanupProbe.exitedPids.join(",") || "none"}`
  ];
  return {
    ...result,
    cleanupVerified: true,
    transcript: transcriptWithCleanup.join("\n")
  };
}

function assertApprovedPorts(ports: readonly number[]): void {
  const outside = ports.filter((port) => port < 3660 || port > 3669);
  if (outside.length > 0) {
    throw new Error(`Portfolio demo attempted to use ports outside ${APPROVED_PORTS}: ${outside.join(", ")}`);
  }
}

function startUiDevServer(): ChildProcess {
  const repoRoot = process.env.INIT_CWD ?? new URL("../../..", import.meta.url).pathname;
  const child = spawn(
    "pnpm",
    ["--filter", "@toolplane/ui", "dev", "--", "--host", "127.0.0.1", "--port", "3661"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        TOOLGUARD_UI_PORT: "3661",
        VITE_TOOLGUARD_CORE_URL: CORE_URL
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

async function assertJson<T>(url: string, label: string): Promise<T> {
  const response = await fetchWithRetry(url, label);
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown, label: string): Promise<T> {
  const response = await fetchWithRetry(url, label, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return (await response.json()) as T;
}

async function assertHttpOk(url: string, label: string): Promise<void> {
  await fetchWithRetry(url, label);
}

async function fetchWithRetry(url: string, label: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`${label} was not reachable on approved loopback surfaces: ${String(lastError)}`);
}

export async function exercisePortfolioAcceptanceSurfaces(handle: McpAdapterDemoApiServerHandle): Promise<string> {
  const { api } = handle;
  const registry = api.registry;
  const session = api.session;
  registerChaosFixtures(registry, { sandboxRoot: session.recorder.runDir });

  const context = {
    runId: session.runId,
    traceId: createId("trace"),
    harnessId: createId("harness"),
    adapterId: createId("adapter")
  };
  const preflight = await session.preflight(registry, context);

  const fixtureLines: string[] = ["Core deterministic chaos fixture preflight:"];
  for (const fixture of REQUIRED_CHAOS_FIXTURES) {
    const finding = preflight.find((candidate) => candidate.toolName === fixture);
    if (!finding) {
      throw new Error(`Missing preflight finding for ${fixture}`);
    }
    fixtureLines.push(`  - ${finding.status}: ${finding.toolName}`);
  }

  const executed = await exerciseCoreChaosFixtures(api, REQUIRED_CHAOS_FIXTURES);
  const recoveredCircuit = await exerciseRecoveringCircuit(api);
  const cli = await exerciseCliWrapper(session.recorder.runDir);
  const python = await exercisePythonAdapters();
  return [
    ...fixtureLines,
    "Core fixture execution:",
    ...executed,
    "Recovering circuit probe:",
    ...recoveredCircuit,
    "CLI wrapper:",
    ...cli,
    "Python framework adapters:",
    ...python
  ].join("\n");
}

async function exerciseCoreChaosFixtures(
  api: McpAdapterDemoApiServerHandle["api"],
  fixtures: readonly string[]
): Promise<string[]> {
  const lines: string[] = [];
  for (const fixture of fixtures) {
    const tool = api.registry.get(fixture);
    if (!tool) {
      throw new Error(`Required chaos fixture is not registered: ${fixture}`);
    }
    if (fixture === "fixture.crash-after-initialize") {
      for (let index = 1; index <= 3; index += 1) {
        const result = await api.session.executeToolCall(
          api.registry,
          makePortfolioCall(api.session.runId, tool.downstreamServerId, fixture, {
            toolCallId: createId("toolcall"),
            attemptId: createId("attempt"),
            policyDecisionId: createId("policy")
          })
        );
        lines.push(`  - ${fixture} attempt ${index}: ${"failureType" in result ? result.failureType : "success"}`);
      }
      continue;
    }
    const result = await api.session.executeToolCall(api.registry, makePortfolioCall(api.session.runId, tool.downstreamServerId, fixture));
    lines.push(`  - ${fixture}: ${"failureType" in result ? result.failureType : "success"}`);
  }
  const events = api.session.recorder.events;
  if (!events.some((event) => event.type === "circuit.opened")) {
    throw new Error("Repeated deterministic failures did not emit circuit.opened.");
  }
  if (!events.some((event) => event.type === "tool.call.failed" && event.data && "failureType" in event.data && event.data.failureType === "circuit_open")) {
    throw new Error("Repeated deterministic failures did not prove circuit fast-fail behavior.");
  }
  return lines;
}

async function exerciseRecoveringCircuit(api: McpAdapterDemoApiServerHandle["api"]): Promise<string[]> {
  const downstreamServerId = createId("server");
  const toolName = "fixture.recovering-circuit";
  let unhealthy = true;
  api.registry.register({
    toolName,
    title: "Recovering circuit fixture",
    description: "Fails twice to open the circuit, then succeeds after the half-open recovery window.",
    protocol: "fixture",
    downstreamServerId,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    destructiveRisk: "none",
    execute: () => {
      if (unhealthy) {
        throw new ClassifiedToolError("process_crash", "Recovering circuit fixture is intentionally unhealthy.", [
          "initial recovery probe failure"
        ]);
      }
      return { ok: true, fixture: "recovering-circuit" };
    }
  });

  const first = await api.session.executeToolCall(api.registry, makePortfolioCall(api.session.runId, downstreamServerId, toolName));
  const second = await api.session.executeToolCall(api.registry, makePortfolioCall(api.session.runId, downstreamServerId, toolName));
  const fastFail = await api.session.executeToolCall(api.registry, makePortfolioCall(api.session.runId, downstreamServerId, toolName));
  await delay(550);
  unhealthy = false;
  const recovered = await api.session.executeToolCall(api.registry, makePortfolioCall(api.session.runId, downstreamServerId, toolName));
  const events = api.session.recorder.events;
  if (!events.some((event) => event.type === "circuit.closed")) {
    throw new Error("Recovering circuit probe did not emit circuit.closed.");
  }
  return [
    `  - first failure: ${"failureType" in first ? first.failureType : "success"}`,
    `  - second failure: ${"failureType" in second ? second.failureType : "success"}`,
    `  - fast fail: ${"failureType" in fastFail ? fastFail.failureType : "success"}`,
    `  - recovery probe: ${"failureType" in recovered ? recovered.failureType : "success"}`
  ];
}

async function exerciseCliWrapper(evidenceRoot: string): Promise<string[]> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runToolplaneCli(
    [
      "run",
      "--evidence-root",
      evidenceRoot,
      "--env",
      "TOOLGUARD_DEMO_SECRET=Bearer tg_demo_1234567890abcdef",
      "--",
      process.execPath,
      "-e",
      "console.log('cli wrapper ok'); console.error(process.env.TOOLGUARD_DEMO_SECRET)"
    ],
    {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk)
    }
  );
  const rendered = [...stdout, ...stderr].join("");
  assertNoSecrets(rendered);
  return [
    `  - toolplane run exitCode: ${result.exitCode}`,
    `  - evidenceRoot: ${evidenceRoot}`,
    `  - redactionReasons: ${result.process?.redactionReasons.join(",") ?? "none"}`
  ];
}

async function exercisePythonAdapters(): Promise<string[]> {
  const repoRoot = process.env.INIT_CWD ?? path.resolve(new URL("../../..", import.meta.url).pathname);
  const pythonPath = path.join(repoRoot, "packages", "python-adapters");
  const script = [
    "from toolguard_adapters import ToolGuardConfig, LangGraphToolGuardTool, CrewAIToolGuardTool",
    `config = ToolGuardConfig(sidecar_endpoint='${CORE_URL}/api/sidecar/v1/tool-calls', timeout_seconds=2.0)`,
    "lang = LangGraphToolGuardTool('fixture.good', config=config).invoke({})",
    "crew = CrewAIToolGuardTool('fixture.prompt-injection-output', config=config).run()",
    "print('langgraph=' + ('failureType' if isinstance(lang, dict) and 'failureType' in lang else 'success'))",
    "print('crewai=' + ('failureType' if isinstance(crew, dict) and 'failureType' in crew else 'success'))"
  ].join("\n");
  const { stdout, stderr } = await execFile("python3", ["-c", script], {
    cwd: repoRoot,
    env: { ...process.env, PYTHONPATH: pythonPath },
    timeout: 10_000
  });
  if (stderr.trim()) {
    throw new Error(`Python adapter smoke wrote stderr: ${stderr}`);
  }
  return stdout.trim().split(/\r?\n/).map((line) => `  - ${line}`);
}

function makePortfolioCall(
  runId: ToolCall["runId"],
  downstreamServerId: ToolCall["downstreamServerId"],
  toolName: string,
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
    toolName,
    arguments: {},
    deadlineMs: toolName === "fixture.good" ? 1_000 : 75,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    ...overrides
  };
}

function requiredEventsSeen(events: readonly CoreEvent[]): readonly string[] {
  const required: readonly CoreEvent["type"][] = [
    "run.started",
    "run.completed",
    "adapter.connected",
    "server.preflight.started",
    "server.preflight.completed",
    "tool.call.started",
    "tool.call.completed",
    "tool.call.failed",
    "tool.retry.scheduled",
    "output.sanitized",
    "circuit.opened",
    "circuit.closed",
    "evidence.artifact.created",
    "report.exported"
  ];
  const seen = new Set(events.map((event) => event.type));
  const missing = required.filter((eventType) => !seen.has(eventType));
  if (missing.length > 0) {
    throw new Error(`Portfolio demo is missing required event types: ${missing.join(", ")}`);
  }
  return required;
}

function assertNoSecrets(text: string): void {
  const secretPatterns = [
    /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
    /sk-[A-Za-z0-9]{12,}/,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
    /TOOLGUARD_DEMO_SECRET\s*=/,
    /tg_demo_1234567890abcdef/
  ];
  const leaked = secretPatterns.find((pattern) => pattern.test(text));
  if (leaked) {
    throw new Error(`Secret-shaped value leaked into portfolio demo surface: ${leaked}`);
  }
}

function assertNoUnsupportedOverclaims(text: string): void {
  const forbidden = [
    /native host tool interception is supported/i,
    /intercepts native host tools/i,
    /unrouted native host tools.*available/i
  ];
  const overclaim = forbidden.find((pattern) => pattern.test(text));
  if (overclaim) {
    throw new Error(`Unsupported integration overclaim found: ${overclaim}`);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function verifyOwnedCleanup(input: {
  readonly ports: readonly number[];
  readonly pids: readonly number[];
}): Promise<{ readonly verified: boolean; readonly closedPorts: readonly number[]; readonly exitedPids: readonly number[]; readonly failures: readonly string[] }> {
  await delay(150);
  const failures: string[] = [];
  const closedPorts: number[] = [];
  for (const port of input.ports) {
    if (await isPortClosed(port)) {
      closedPorts.push(port);
    } else {
      failures.push(`127.0.0.1:${port} is still accepting connections`);
    }
  }

  const exitedPids: number[] = [];
  for (const pid of input.pids) {
    if (isPidExited(pid)) {
      exitedPids.push(pid);
    } else {
      failures.push(`owned child process ${pid} is still alive`);
    }
  }

  return {
    verified: failures.length === 0,
    closedPorts,
    exitedPids,
    failures
  };
}

async function isPortClosed(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (closed: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(closed);
    };
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
    socket.setTimeout(500, () => done(true));
  });
}

function isPidExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function parseHoldMs(argv: readonly string[]): number {
  const inline = argv.find((arg) => arg.startsWith("--hold-ms="));
  if (inline) {
    return Number(inline.slice("--hold-ms=".length));
  }
  const index = argv.indexOf("--hold-ms");
  if (index >= 0 && argv[index + 1]) {
    return Number(argv[index + 1]);
  }
  return Number(process.env.TOOLGUARD_DEMO_HOLD_MS ?? 1_500);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let stopping = false;
  const abort = new AbortController();
  const shutdown = (): void => {
    if (!stopping) {
      stopping = true;
      abort.abort();
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const holdMs = parseHoldMs(process.argv.slice(2));
  Promise.race([
    runPortfolioDemo({ holdMs: Number.isFinite(holdMs) && holdMs >= 0 ? holdMs : 1_500 }),
    new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("Demo shutdown requested."))))
  ])
    .then((result) => {
      console.log(result.transcript);
      console.log("shutdown: cleaned up ToolGuard-owned Core/API and UI processes");
    })
    .catch((error: unknown) => {
      if (stopping) {
        console.log("shutdown: cleaned up ToolGuard-owned Core/API and UI processes");
        return;
      }
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
