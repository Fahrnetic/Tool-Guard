import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { buildDemoStoryModePayload } from "@toolplane/core";
import { createMcpAdapterDemoApiServer, type McpAdapterDemoApiServerHandle } from "./demo.js";

const CORE_PORT = 3660;
const UI_PORT = 3661;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const UI_URL = `http://127.0.0.1:${UI_PORT}`;

export interface StoryModeServeHandle {
  readonly core: McpAdapterDemoApiServerHandle;
  readonly ui: ChildProcess;
  readonly transcript: string;
  close(): Promise<void>;
}

export async function startStoryModeDemoServe(): Promise<StoryModeServeHandle> {
  await assertApprovedPortFree(CORE_PORT);
  await assertApprovedPortFree(UI_PORT);
  const core = await createMcpAdapterDemoApiServer({ host: "127.0.0.1", port: CORE_PORT });
  const ui = startUiDevServer();
  try {
    await assertHttpOk(`${CORE_URL}/health`, "Core/API");
    await assertHttpOk(UI_URL, "UI");
    const story = buildDemoStoryModePayload();
    const transcript = [
      "ToolGuard guided demo story mode",
      "serveCommand: pnpm demo:serve",
      `coreApi: ${CORE_URL}`,
      `ui: ${UI_URL}`,
      "fixtureStack: deterministic in-process and loopback-only fixtures on approved ports 3660-3664",
      `scenarioCount: ${story.scenarios.length}`,
      "scenarios:",
      ...story.scenarios.map((scenario) => `  - ${scenario.stableLabel} (${scenario.route}) -> ${scenario.deterministicOutcome}`),
      "stages:",
      ...story.stageOrder.map((stage, index) => `  ${index + 1}. ${stage.label}`),
      "cleanup: SIGINT/SIGTERM closes Core/API and owned UI child process by PID",
      "status: running for human viewing until explicitly stopped"
    ].join("\n");
    return {
      core,
      ui,
      transcript,
      close: async () => {
        await stopChild(ui);
        await core.close();
      }
    };
  } catch (error) {
    await stopChild(ui);
    await core.close();
    throw error;
  }
}

function startUiDevServer(): ChildProcess {
  const repoRoot = process.env.INIT_CWD ?? new URL("../../..", import.meta.url).pathname;
  const child = spawn("pnpm", ["--filter", "@toolplane/ui", "dev", "--", "--host", "127.0.0.1", "--port", String(UI_PORT)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TOOLGUARD_UI_PORT: String(UI_PORT),
      VITE_TOOLGUARD_CORE_URL: CORE_URL
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[ui] ${chunk.toString("utf8")}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[ui] ${chunk.toString("utf8")}`);
  });
  return child;
}

async function assertHttpOk(url: string, label: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`${label} did not become reachable on ${url}: ${String(lastError)}`);
}

async function assertApprovedPortFree(port: number): Promise<void> {
  if (port < 3660 || port > 3669) {
    throw new Error(`Refusing to use port ${port}. Demo story mode is limited to approved ports 3660-3669.`);
  }
  const closed = await isPortClosed(port);
  if (!closed) {
    throw new Error(`Port ${port} is already in use. Stop the existing approved ToolGuard service before running demo:serve.`);
  }
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let handle: StoryModeServeHandle | undefined;
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log("shutdown: stopping ToolGuard story mode services");
    await handle?.close();
    console.log("shutdown: cleaned up ToolGuard-owned Core/API and UI processes");
  };
  process.on("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });

  startStoryModeDemoServe()
    .then(async (started) => {
      handle = started;
      console.log(started.transcript);
      await new Promise<void>(() => undefined);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
