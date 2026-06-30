import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createId } from "./ids.js";
import type { StableId } from "./ids.js";
import type { CoreSession } from "./session.js";
import { SIDECAR_PROTOCOL_VERSION } from "./sidecar-protocol.js";
import type {
  EvidenceLink,
  IntegrationCapabilityCheck,
  IntegrationRouteCoverageEntry,
  IntegrationRouteType,
  IntegrationVerificationReceipt,
  JsonValue
} from "./types.js";

export interface IntegrationVerificationInput {
  readonly session: CoreSession;
  readonly routeType: IntegrationRouteType;
  readonly workspaceRoot?: string;
  readonly probeTimeoutMs?: number;
}

const execFileAsync = promisify(execFile);

const LIMITATIONS: Record<IntegrationRouteType, string> = {
  "mcp-routed":
    "Local-only MCP verification checks calls routed through ToolGuard MCP configuration only; native host tools remain outside the claim.",
  "sdk-wrapped-python":
    "Local-only Python verification checks SDK wrapper and loopback sidecar boundaries only; direct framework tools are not intercepted.",
  "cli-supervised":
    "Local-only CLI verification checks process-level supervision only; native agent tool calls require MCP, SDK wrapper, or ToolGuard API routing."
};

const ROUTE_LABELS: Record<IntegrationRouteType, string> = {
  "mcp-routed": "MCP routed adapter path",
  "sdk-wrapped-python": "Python SDK-wrapped sidecar path",
  "cli-supervised": "CLI supervised process path"
};

export async function verifyIntegrationRoute(
  input: IntegrationVerificationInput
): Promise<IntegrationVerificationReceipt> {
  const receiptId = createId("receipt");
  const timestamp = new Date().toISOString();
  const checkedCapabilities = await buildCapabilityChecks(input);
  const routeCoverage = buildRouteCoverage(input.routeType, checkedCapabilities);
  const receiptWithoutLinks = {
    receiptId,
    runId: input.session.runId,
    timestamp,
    routeType: input.routeType,
    checkedCapabilities,
    routeCoverage,
    limitation: LIMITATIONS[input.routeType]
  } satisfies Omit<IntegrationVerificationReceipt, "evidenceLinks">;

  const artifact = await input.session.recordRawArtifact(makeArtifactContext(input.session.runId, input.routeType), {
    kind: "verification-receipt",
    fileName: `integration-verification-${input.routeType}-${receiptId}.json`,
    content: receiptWithoutLinks as unknown as JsonValue,
    redacted: true
  });
  const evidenceLinks: EvidenceLink[] = [
    {
      artifactId: artifact.artifactId,
      href: artifact.relativePath,
      label: `Verification receipt for ${input.routeType}`
    }
  ];
  const receipt: IntegrationVerificationReceipt = { ...receiptWithoutLinks, evidenceLinks };
  await input.session.emitIntegrationVerified(receipt);
  return receipt;
}

function buildRouteCoverage(
  routeType: IntegrationRouteType,
  checkedCapabilities: readonly IntegrationCapabilityCheck[]
): readonly IntegrationRouteCoverageEntry[] {
  const configured = checkedCapabilities.some((check) => check.status === "configured");
  const available = checkedCapabilities.some((check) => check.status === "available");
  const notVerified = checkedCapabilities.some((check) => check.status === "not-yet-verified");
  return [
    {
      state: "configured",
      label: `${ROUTE_LABELS[routeType]} configured`,
      localOnly: true,
      evidence: configured
        ? "At least one local route configuration check passed."
        : "No local route configuration check passed in this doctor run."
    },
    {
      state: "available",
      label: `${ROUTE_LABELS[routeType]} available`,
      localOnly: true,
      evidence: available
        ? "At least one local route availability probe passed."
        : "No local route availability probe passed in this doctor run."
    },
    {
      state: "unsupported",
      label: "Native host tool interception unsupported",
      localOnly: true,
      evidence: LIMITATIONS[routeType]
    },
    {
      state: "not-verified",
      label: `${ROUTE_LABELS[routeType]} checks not verified`,
      localOnly: true,
      evidence: notVerified
        ? "One or more local-only probes did not pass and require follow-up before claiming availability."
        : "All local-only probes in this receipt passed; no pending route checks remain for this doctor run."
    },
    {
      state: "producing-evidence",
      label: `${ROUTE_LABELS[routeType]} producing evidence`,
      localOnly: true,
      evidence: "The integration doctor wrote this route receipt as a hashed evidence artifact and emitted an integration.verified event."
    }
  ];
}

async function buildCapabilityChecks(input: IntegrationVerificationInput): Promise<readonly IntegrationCapabilityCheck[]> {
  const workspaceRoot = input.workspaceRoot ?? (await findWorkspaceRoot(process.cwd()));
  const timeoutMs = input.probeTimeoutMs ?? 5_000;
  if (input.routeType === "mcp-routed") {
    return await Promise.all([
      probeCapability("adapter availability", "available", async () => probeMcpAdapterAvailability(workspaceRoot, timeoutMs)),
      probeCapability("config snippet validity", "configured", async () => probeMcpConfigSnippetValidity(workspaceRoot, timeoutMs)),
      probeCapability("tool exposure", "available", async () => probeMcpToolExposure(workspaceRoot, timeoutMs))
    ]);
  }
  if (input.routeType === "sdk-wrapped-python") {
    return await Promise.all([
      probeCapability("sidecar compatibility", "available", async () => probePythonSidecarCompatibility(workspaceRoot, timeoutMs)),
      probeCapability("loopback URL safety", "available", async () => probePythonLoopbackSafety(workspaceRoot, timeoutMs)),
      probeCapability("wrapper route", "configured", async () => probePythonWrapperRoute(workspaceRoot))
    ]);
  }
  return await Promise.all([
    probeCapability("process probe", "available", async () => probeCliProcess(workspaceRoot, timeoutMs)),
    probeCapability("argv boundary", "available", async () => probeCliArgvBoundary(workspaceRoot, timeoutMs)),
    probeCapability("destructive guard", "available", async () => probeCliDestructiveGuard(workspaceRoot, timeoutMs))
  ]);
}

async function probeCapability(
  capabilityName: string,
  successStatus: Extract<IntegrationCapabilityCheck["status"], "available" | "configured">,
  probe: () => Promise<string>
): Promise<IntegrationCapabilityCheck> {
  try {
    return capability(capabilityName, successStatus, await probe());
  } catch (error) {
    return capability(capabilityName, "not-yet-verified", `Local probe executed but did not pass: ${messageFromError(error)}`);
  }
}

function capability(
  capabilityName: string,
  status: IntegrationCapabilityCheck["status"],
  evidence: string
): IntegrationCapabilityCheck {
  return { capability: capabilityName, status, localOnly: true, evidence };
}

async function probeMcpAdapterAvailability(workspaceRoot: string, timeoutMs: number): Promise<string> {
  const packageJsonPath = path.join(workspaceRoot, "packages/mcp-adapter/package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: string; exports?: unknown };
  if (packageJson.name !== "@toolplane/mcp-adapter") {
    throw new Error(`unexpected package name ${String(packageJson.name)}`);
  }
  await access(path.join(workspaceRoot, "packages/mcp-adapter/dist/index.js"));
  const output = await runNodeProbe(
    workspaceRoot,
    `
      const adapter = await import(${JSON.stringify(pathToFileUrl(path.join(workspaceRoot, "packages/mcp-adapter/dist/index.js")))});
      if (typeof adapter.ToolGuardMcpRouter !== "function") throw new Error("ToolGuardMcpRouter export missing");
      if (typeof adapter.generateHostConfigSnippets !== "function") throw new Error("generateHostConfigSnippets export missing");
      console.log("mcp-adapter exports available");
    `,
    timeoutMs
  );
  return `Executed adapter import probe for ${packageJson.name}: ${output}`;
}

async function findWorkspaceRoot(startDir: string): Promise<string> {
  let current = startDir;
  for (;;) {
    try {
      await access(path.join(current, "pnpm-workspace.yaml"));
      await access(path.join(current, "packages"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return startDir;
      }
      current = parent;
    }
  }
}

async function probeMcpConfigSnippetValidity(workspaceRoot: string, timeoutMs: number): Promise<string> {
  const output = await runNodeProbe(
    workspaceRoot,
    `
      const { generateHostConfigSnippets } = await import(${JSON.stringify(pathToFileUrl(path.join(workspaceRoot, "packages/mcp-adapter/dist/config-snippets.js")))});
      const snippets = generateHostConfigSnippets({ toolplaneRepoPath: ${JSON.stringify(workspaceRoot)} });
      if (!Array.isArray(snippets) || snippets.length < 3) throw new Error("expected multiple host snippets");
      for (const snippet of snippets) {
        const config = JSON.parse(snippet.configJson);
        const server = config?.mcpServers?.toolguard;
        if (!server || !Array.isArray(server.args) || typeof server.command !== "string") throw new Error("invalid server command");
        if (server.env?.TOOLGUARD_CORE_URL !== "http://127.0.0.1:3660") throw new Error("non-loopback core URL");
        if (JSON.stringify(server).match(/sk-[A-Za-z0-9]|Bearer\\s+|BEGIN PRIVATE KEY/)) throw new Error("secret-shaped snippet content");
        if (!snippet.limitations.join(" ").includes("Native host tools are not intercepted")) throw new Error("missing route limitation");
      }
      console.log(String(snippets.length));
    `,
    timeoutMs
  );
  return `Executed config generation probe and parsed ${output} loopback MCP snippets with no secret-shaped values.`;
}

async function probeMcpToolExposure(workspaceRoot: string, timeoutMs: number): Promise<string> {
  const output = await runNodeProbe(
    workspaceRoot,
    `
      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");
      const adapter = await import(${JSON.stringify(pathToFileUrl(path.join(workspaceRoot, "packages/mcp-adapter/dist/index.js")))});
      const core = await import(${JSON.stringify(pathToFileUrl(path.join(workspaceRoot, "packages/core/dist/index.js")))});
      const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "toolguard-mcp-probe-"));
      const session = new core.CoreSession({ evidenceRoot, runId: core.createId("run") });
      const registry = new core.ToolRegistry();
      const downstream = adapter.createInMemoryDownstreamServer({
        serverId: core.createId("server"),
        name: "probe-downstream",
        tools: [{ name: "echo", description: "probe", inputSchema: { type: "object", properties: {} } }],
        handler: async () => ({ ok: true })
      });
      const router = await adapter.ToolGuardMcpRouter.create({ session, coreRegistry: registry, downstreamServers: [downstream] });
      const tools = router.listVirtualTools();
      if (tools.length !== 1 || !tools[0].name.startsWith("tg__") || tools[0].originalToolName !== "echo") {
        throw new Error("virtual tool exposure failed");
      }
      await router.close();
      console.log(tools[0].name);
    `,
    timeoutMs
  );
  return `Executed MCP router probe and observed virtual ToolGuard tool exposure: ${output}.`;
}

async function probePythonSidecarCompatibility(workspaceRoot: string, timeoutMs: number): Promise<string> {
  const output = await runPythonProbe(
    workspaceRoot,
    `
from toolguard_adapters import SIDECAR_PROTOCOL_VERSION, ToolGuardConfig
config = ToolGuardConfig()
config.validate_local()
if SIDECAR_PROTOCOL_VERSION != ${JSON.stringify(SIDECAR_PROTOCOL_VERSION)}:
    raise SystemExit("protocol mismatch")
print(SIDECAR_PROTOCOL_VERSION)
    `,
    timeoutMs
  );
  return `Executed Python adapter import probe and matched sidecar protocol ${output}.`;
}

async function probePythonLoopbackSafety(workspaceRoot: string, timeoutMs: number): Promise<string> {
  const output = await runPythonProbe(
    workspaceRoot,
    `
from toolguard_adapters import ToolGuardConfig
ToolGuardConfig(sidecar_endpoint="http://127.0.0.1:3660/api/sidecar/v1/tool-calls").validate_local()
ToolGuardConfig(sidecar_endpoint="http://localhost:3660/api/sidecar/v1/tool-calls").validate_local()
try:
    ToolGuardConfig(sidecar_endpoint="https://example.com/api/sidecar/v1/tool-calls").validate_local()
except ValueError:
    print("loopback-only")
else:
    raise SystemExit("non-loopback endpoint accepted")
    `,
    timeoutMs
  );
  return `Executed Python loopback safety probe: ${output}.`;
}

async function probePythonWrapperRoute(workspaceRoot: string): Promise<string> {
  const langgraph = await readFile(path.join(workspaceRoot, "packages/python-adapters/toolguard_adapters/langgraph.py"), "utf8");
  const crewai = await readFile(path.join(workspaceRoot, "packages/python-adapters/toolguard_adapters/crewai.py"), "utf8");
  if (!langgraph.includes("ToolGuardSidecarClient") || !crewai.includes("ToolGuardSidecarClient")) {
    throw new Error("framework wrappers do not route through ToolGuardSidecarClient");
  }
  return "Read local framework wrappers and verified they route calls through ToolGuardSidecarClient.";
}

async function probeCliProcess(workspaceRoot: string, timeoutMs: number): Promise<string> {
  const result = await runCliProbe(workspaceRoot, ["run", "--json", "--", "node", "-e", "process.stdout.write('toolguard-process-ok')"], timeoutMs);
  if (result.exitCode !== 0 || result.process?.stdout !== "toolguard-process-ok") {
    throw new Error("CLI process probe did not return expected stdout");
  }
  return `Executed CLI process probe through ${String(result.process.command)} with exitCode ${String(result.exitCode)}.`;
}

async function probeCliArgvBoundary(workspaceRoot: string, timeoutMs: number): Promise<string> {
  const marker = "literal value with spaces; $HOME";
  const result = await runCliProbe(
    workspaceRoot,
    ["run", "--json", "--", "node", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", marker],
    timeoutMs
  );
  if (result.exitCode !== 0 || !String(result.process?.stdout ?? "").includes(marker)) {
    throw new Error("CLI argv boundary probe did not preserve literal argument");
  }
  const argv = result.process?.argv;
  if (!Array.isArray(argv) || argv.at(-1) !== marker) {
    throw new Error("CLI JSON summary did not preserve argv boundary");
  }
  return "Executed CLI argv probe and verified a literal post--- argument was preserved without shell expansion.";
}

async function probeCliDestructiveGuard(workspaceRoot: string, timeoutMs: number): Promise<string> {
  const result = await runCliProbe(workspaceRoot, ["run", "--json", "--", "rm", "-rf", "definitely-not-executed"], timeoutMs);
  if (result.exitCode === 0 || result.failureCard?.failureType !== "destructive_action_blocked") {
    throw new Error("destructive command was not blocked by CLI guard");
  }
  return `Executed CLI destructive guard probe and observed ${String(result.failureCard.failureType)} before process execution.`;
}

async function runCliProbe(workspaceRoot: string, args: readonly string[], timeoutMs: number): Promise<Record<string, any>> {
  const output = await execFileChecked(
    process.execPath,
    [path.join(workspaceRoot, "packages/cli/dist/bin/toolplane.js"), ...args],
    workspaceRoot,
    timeoutMs,
    true
  );
  return JSON.parse(output) as Record<string, any>;
}

async function runNodeProbe(workspaceRoot: string, script: string, timeoutMs: number): Promise<string> {
  return await execFileChecked(process.execPath, ["--input-type=module", "-e", script], workspaceRoot, timeoutMs);
}

async function runPythonProbe(workspaceRoot: string, script: string, timeoutMs: number): Promise<string> {
  return await execFileChecked("python3", ["-c", script], workspaceRoot, timeoutMs, false, {
    PYTHONPATH: path.join(workspaceRoot, "packages/python-adapters")
  });
}

async function execFileChecked(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  allowNonZero = false,
  env: Record<string, string> = {}
): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ...env }
  }).catch((error: unknown) => {
    if (allowNonZero && isExecError(error) && typeof error.stdout === "string" && error.stdout.trim().length > 0) {
      return { stdout: error.stdout, stderr: String(error.stderr ?? "") };
    }
    throw error;
  });
  const trimmed = String(stdout).trim();
  if (trimmed.length === 0 && String(stderr).trim().length > 0) {
    throw new Error(String(stderr).trim());
  }
  return trimmed;
}

function pathToFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}

function isExecError(error: unknown): error is { stdout?: unknown; stderr?: unknown } {
  return typeof error === "object" && error !== null && "stdout" in error;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function makeArtifactContext(runId: StableId, routeType: IntegrationRouteType) {
  return {
    runId,
    traceId: createId("trace"),
    toolCallId: createId("toolcall"),
    harnessId: createId("harness"),
    adapterId: createId("adapter"),
    downstreamServerId: createId("server"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName: `integration.verify.${routeType}`,
    arguments: {},
    idempotency: "idempotent" as const,
    sourcePath: "non-mcp-direct" as const
  };
}
