import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createMcpAdapterDemoApiServer, type McpAdapterDemoApiServerHandle } from "./demo.js";

const CORE_URL = "http://127.0.0.1:3660";
const UI_URL = "http://127.0.0.1:3661";
const APPROVED_PORTS = "3660-3669";

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
  readonly integrationClaimLevels: readonly string[];
  readonly transcript: string;
}

export async function runPortfolioDemo(options: PortfolioDemoOptions = {}): Promise<PortfolioDemoResult> {
  const startUi = options.startUi ?? true;
  const holdMs = options.holdMs ?? 1_500;
  let handle: McpAdapterDemoApiServerHandle | undefined;
  let ui: ChildProcess | undefined;
  const transcript: string[] = [
    "ToolGuard portfolio demo",
    `approvedPorts: ${APPROVED_PORTS}`,
    `coreApi: ${CORE_URL}`
  ];

  try {
    handle = await createMcpAdapterDemoApiServer({ host: "127.0.0.1", port: 3660 });
    await assertJson(`${CORE_URL}/health`, "Core/API health");
    const report = await assertJson<{
      readonly reportHtml: string;
      readonly manifestJson: string;
      readonly manifestValid: boolean;
    }>(`${CORE_URL}/api/reports/export`, "report export");
    if (!report.manifestValid) {
      throw new Error("Portfolio demo report manifest did not validate.");
    }

    if (startUi) {
      ui = startUiDevServer();
      await assertHttpOk(UI_URL, "UI");
      transcript.push(`ui: ${UI_URL}`);
    }

    const latest = await assertJson<{ readonly eventCount: number }>(`${CORE_URL}/api/runs/latest`, "latest run");
    const health = await assertJson<{
      readonly rows: readonly { readonly name: string; readonly status: string }[];
    }>(`${CORE_URL}/api/health`, "preflight matrix");
    const failures = await assertJson<{ readonly failures: readonly unknown[] }>(`${CORE_URL}/api/failures`, "failures");
    const integrations = await assertJson<{
      readonly integrations: readonly { readonly name: string; readonly route: string; readonly claimLevel: string; readonly limitation: string }[];
    }>(`${CORE_URL}/api/integrations`, "integration claim audit");

    transcript.push(
      handle.result.transcript,
      `runId: ${handle.result.runId}`,
      `evidenceDir: ${handle.result.evidenceDir}`,
      `reportHtml: ${report.reportHtml}`,
      `manifestJson: ${report.manifestJson}`,
      `eventCount: ${latest.eventCount}`,
      `failureCards: ${failures.failures.length}`,
      "preflight matrix:",
      ...health.rows.map((row) => `  - ${row.status}: ${row.name}`),
      "integration claim-level audit:",
      ...integrations.integrations.map(
        (integration) =>
          `  - ${integration.name}: ${integration.route}, ${integration.claimLevel}; ${integration.limitation}`
      )
    );

    if (holdMs > 0) {
      transcript.push(`holdMs: ${holdMs}`);
      await delay(holdMs);
    }

    return {
      runId: handle.result.runId,
      evidenceDir: handle.result.evidenceDir,
      coreUrl: CORE_URL,
      ...(startUi ? { uiUrl: UI_URL } : {}),
      reportHtml: report.reportHtml,
      manifestJson: report.manifestJson,
      eventCount: latest.eventCount,
      failureCount: failures.failures.length,
      preflightStatuses: health.rows.map((row) => `${row.name}:${row.status}`),
      integrationClaimLevels: integrations.integrations.map(
        (integration) => `${integration.name}:${integration.route}:${integration.claimLevel}`
      ),
      transcript: transcript.join("\n")
    };
  } finally {
    if (ui) {
      await stopChild(ui);
    }
    if (handle) {
      await handle.close();
    }
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

async function assertHttpOk(url: string, label: string): Promise<void> {
  await fetchWithRetry(url, label);
}

async function fetchWithRetry(url: string, label: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
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
