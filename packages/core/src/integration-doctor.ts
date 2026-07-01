import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CoreSession } from "./session.js";
import { createId } from "./ids.js";
import { exportEvidenceBundle } from "./bundle.js";
import { verifyIntegrationRoute } from "./integration-verification.js";
import { redactJsonValueWithSummary } from "./redaction.js";
import type {
  EvidenceLink,
  HostPlatformPassport,
  IntegrationCapabilityCheck,
  IntegrationRouteCoverageEntry,
  IntegrationRouteType,
  IntegrationVerificationReceipt,
  JsonValue
} from "./types.js";

export const INTEGRATION_DOCTOR_ROUTES: readonly IntegrationRouteType[] = [
  "mcp-routed",
  "cli-supervised",
  "sdk-wrapped-python"
];

export interface IntegrationDoctorResult {
  readonly runId: string;
  readonly evidenceDir: string;
  readonly eventsPath: string;
  readonly receipts: readonly IntegrationVerificationReceipt[];
  readonly bundleManifest: string;
  readonly bundleValid: boolean;
  readonly validationErrors: readonly string[];
}

export interface IntegrationDoctorJson {
  readonly schemaVersion: "toolguard.integration-doctor.v1";
  readonly kind: "toolguard.integrationDoctor";
  readonly generatedAt: string;
  readonly run: {
    readonly runId: string;
    readonly evidenceDir: string;
    readonly eventsPath: string;
  };
  readonly noSecrets: {
    readonly status: "passed" | "failed";
    readonly redactionsApplied: number;
    readonly scannedFields: readonly string[];
  };
  readonly routes: readonly IntegrationDoctorRouteJson[];
  readonly receipts: readonly IntegrationDoctorReceiptJson[];
  readonly artifactBundle: {
    readonly manifestPath: string;
    readonly valid: boolean;
    readonly validationErrors: readonly string[];
    readonly localOnly: true;
    readonly requiresExternalCredentials: false;
  };
  readonly ci: {
    readonly localReceiptCommand: string;
    readonly githubActionsCompatible: true;
    readonly requiresExternalCredentials: false;
    readonly artifactPaths: readonly string[];
    readonly workflowSnippet: readonly string[];
  };
}

export interface IntegrationDoctorRouteJson {
  readonly routeType: IntegrationRouteType;
  readonly receiptId: string;
  readonly passport: HostPlatformPassport | null;
  readonly checkedCapabilities: readonly IntegrationCapabilityCheck[];
  readonly routeCoverage: readonly IntegrationRouteCoverageEntry[];
  readonly evidenceLinks: readonly EvidenceLink[];
  readonly limitation: string;
  readonly limitations: readonly string[];
  readonly noSecretsStatus: "passed";
}

export interface IntegrationDoctorReceiptJson {
  readonly receiptId: string;
  readonly routeType: IntegrationRouteType;
  readonly evidenceLinks: readonly EvidenceLink[];
  readonly producingEvidence: boolean;
  readonly smokeTestStatus: IntegrationVerificationReceipt["smokeTestStatus"];
}

export interface IntegrationDoctorCliOptions {
  readonly json: boolean;
  readonly evidenceRoot?: string;
  readonly workspaceRoot?: string;
  readonly runId?: string;
  readonly probeTimeoutMs?: number;
}

export async function runIntegrationDoctor(input: {
  readonly evidenceRoot?: string;
  readonly workspaceRoot?: string;
  readonly runId?: string;
  readonly probeTimeoutMs?: number;
} = {}): Promise<IntegrationDoctorResult> {
  const workspaceRoot = input.workspaceRoot ?? (await findWorkspaceRoot(process.env.INIT_CWD ?? process.cwd()));
  const evidenceRoot = input.evidenceRoot ?? path.join(workspaceRoot, "runs");
  const session = new CoreSession({
    evidenceRoot,
    runId: createIdFromInput(input.runId)
  });
  const receipts: IntegrationVerificationReceipt[] = [];

  for (const routeType of INTEGRATION_DOCTOR_ROUTES) {
    receipts.push(
      await verifyIntegrationRoute({
        session,
        routeType,
        workspaceRoot,
        ...(input.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: input.probeTimeoutMs })
      })
    );
  }

  const bundle = await exportEvidenceBundle({ session });
  return {
    runId: session.runId,
    evidenceDir: session.recorder.runDir,
    eventsPath: session.recorder.eventsPath,
    receipts,
    bundleManifest: bundle.manifestPath,
    bundleValid: bundle.validation.valid,
    validationErrors: [...bundle.validation.errors]
  };
}

export function buildIntegrationDoctorJson(result: IntegrationDoctorResult, generatedAt = new Date().toISOString()): IntegrationDoctorJson {
  const artifactPaths = [
    result.eventsPath,
    result.bundleManifest,
    path.join(path.dirname(result.bundleManifest), "integration-verification-receipts.json"),
    path.join(path.dirname(result.bundleManifest), "manifest.json")
  ];
  const jsonWithoutNoSecrets = {
    schemaVersion: "toolguard.integration-doctor.v1",
    kind: "toolguard.integrationDoctor",
    generatedAt,
    run: {
      runId: result.runId,
      evidenceDir: result.evidenceDir,
      eventsPath: result.eventsPath
    },
    routes: result.receipts.map((receipt) => routeJson(receipt)),
    receipts: result.receipts.map((receipt) => receiptJson(receipt)),
    artifactBundle: {
      manifestPath: result.bundleManifest,
      valid: result.bundleValid,
      validationErrors: [...result.validationErrors],
      localOnly: true,
      requiresExternalCredentials: false
    },
    ci: {
      localReceiptCommand: "pnpm --silent doctor:integrations -- --json",
      githubActionsCompatible: true,
      requiresExternalCredentials: false,
      artifactPaths,
      workflowSnippet: [
        "name: ToolGuard integration doctor",
        "on: [push, pull_request]",
        "jobs:",
        "  integration-doctor:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: pnpm/action-setup@v4",
        "        with:",
        "          version: 10.25.0",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 22",
        "          cache: pnpm",
        "      - run: pnpm install --frozen-lockfile",
        "      - run: pnpm build",
        "      - run: pnpm --silent doctor:integrations -- --json > toolguard-integration-doctor.json",
        "      - uses: actions/upload-artifact@v4",
        "        with:",
        "          name: toolguard-integration-doctor",
        "          path: |",
        "            toolguard-integration-doctor.json",
        "            runs/**/bundle/**"
      ]
    }
  } satisfies Omit<IntegrationDoctorJson, "noSecrets">;
  const redaction = redactJsonValueWithSummary(jsonWithoutNoSecrets as unknown as JsonValue);
  const redacted = redaction.value as unknown as Omit<IntegrationDoctorJson, "noSecrets">;
  const redactionsApplied = redaction.count;
  return {
    ...redacted,
    noSecrets: {
      status: redactionsApplied === 0 ? "passed" : "failed",
      redactionsApplied,
      scannedFields: ["routes", "receipts", "artifactBundle", "ci", "run"]
    }
  };
}

export function renderIntegrationDoctorHuman(result: IntegrationDoctorResult): string {
  const lines = [
    "ToolGuard integration doctor",
    "humanOutput: true",
    "machineJson: rerun with --json for stable schema toolguard.integration-doctor.v1",
    `runId: ${result.runId}`,
    `evidenceDir: ${result.evidenceDir}`,
    `eventsJsonl: ${result.eventsPath}`,
    `bundleManifest: ${result.bundleManifest}`,
    `bundleValid: ${String(result.bundleValid)}`
  ];
  for (const receipt of result.receipts) {
    const capabilityStates = receipt.checkedCapabilities
      .map((capability) => `${capability.capability}=${capability.status}`)
      .join(", ");
    const coverageStates = receipt.routeCoverage.map((entry) => entry.state).join(", ");
    lines.push(`receipt: ${receipt.routeType}`);
    lines.push(`  receiptId: ${receipt.receiptId}`);
    lines.push(`  passportId: ${receipt.platformPassport?.passportId ?? "not-available"}`);
    lines.push(`  capabilities: ${capabilityStates}`);
    lines.push(`  coverage: ${coverageStates}`);
    lines.push(`  limitation: ${receipt.limitation}`);
    lines.push(`  evidenceLinks: ${receipt.evidenceLinks.map((link) => link.href).join(", ")}`);
  }
  lines.push("ciReceiptCommand: pnpm --silent doctor:integrations -- --json > toolguard-integration-doctor.json");
  lines.push(`ciArtifactBundle: ${path.dirname(result.bundleManifest)}`);
  return `${lines.join("\n")}\n`;
}

export function parseIntegrationDoctorCliArgs(argv: readonly string[]): IntegrationDoctorCliOptions {
  let json = false;
  let evidenceRoot: string | undefined;
  let workspaceRoot: string | undefined;
  let runId: string | undefined;
  let probeTimeoutMs: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    switch (option) {
      case "--":
        break;
      case "--json":
        json = true;
        break;
      case "--evidence-root":
        evidenceRoot = requireCliValue(argv, ++index, "--evidence-root");
        break;
      case "--workspace-root":
        workspaceRoot = requireCliValue(argv, ++index, "--workspace-root");
        break;
      case "--run-id":
        runId = requireCliValue(argv, ++index, "--run-id");
        break;
      case "--probe-timeout-ms":
        probeTimeoutMs = Number(requireCliValue(argv, ++index, "--probe-timeout-ms"));
        if (!Number.isInteger(probeTimeoutMs) || probeTimeoutMs <= 0) {
          throw new Error("--probe-timeout-ms must be a positive integer.");
        }
        break;
      default:
        throw new Error(`Unknown integration doctor option: ${String(option)}`);
    }
  }
  return {
    json,
    ...(evidenceRoot ? { evidenceRoot } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(runId ? { runId } : {}),
    ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {})
  };
}

export async function runIntegrationDoctorCli(
  argv: readonly string[] = process.argv.slice(2),
  output: { readonly stdout?: (chunk: string) => void; readonly stderr?: (chunk: string) => void } = {}
): Promise<IntegrationDoctorResult> {
  const parsed = parseIntegrationDoctorCliArgs(argv);
  const result = await runIntegrationDoctor(parsed);
  const stdout = output.stdout ?? ((chunk) => process.stdout.write(chunk));
  if (parsed.json) {
    stdout(`${JSON.stringify(buildIntegrationDoctorJson(result), null, 2)}\n`);
  } else {
    stdout(renderIntegrationDoctorHuman(result));
  }
  if (!result.bundleValid) {
    throw new Error(`Integration doctor bundle validation failed: ${result.validationErrors.join("; ")}`);
  }
  return result;
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

function routeJson(receipt: IntegrationVerificationReceipt): IntegrationDoctorRouteJson {
  return {
    routeType: receipt.routeType,
    receiptId: receipt.receiptId,
    passport: receipt.platformPassport ?? null,
    checkedCapabilities: receipt.checkedCapabilities,
    routeCoverage: receipt.routeCoverage,
    evidenceLinks: receipt.evidenceLinks,
    limitation: receipt.limitation,
    limitations: receipt.limitations ?? [receipt.limitation],
    noSecretsStatus: "passed"
  };
}

function receiptJson(receipt: IntegrationVerificationReceipt): IntegrationDoctorReceiptJson {
  return {
    receiptId: receipt.receiptId,
    routeType: receipt.routeType,
    evidenceLinks: receipt.evidenceLinks,
    producingEvidence: receiptProducesRouteEvidence(receipt),
    smokeTestStatus: receipt.smokeTestStatus
  };
}

function receiptProducesRouteEvidence(receipt: IntegrationVerificationReceipt): boolean {
  if (receipt.smokeTestStatus !== "passed") return false;
  return (
    receipt.checkedCapabilities.some((check) => routeSpecificEvidenceCapabilityPassed(receipt.routeType, check)) ||
    receipt.evidenceLinks.some((link) => link.routeType === receipt.routeType && link.evidenceScope === "route")
  );
}

function routeSpecificEvidenceCapabilityPassed(
  routeType: IntegrationRouteType,
  check: IntegrationCapabilityCheck
): boolean {
  if (check.status !== "configured" && check.status !== "available") return false;
  const capability = check.capability.toLowerCase();
  if (routeType === "mcp-routed") return capability === "virtual routed tool evidence";
  if (routeType === "sdk-wrapped-python") return capability === "wrapper sidecar evidence";
  return capability === "process probe";
}

function requireCliValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function createIdFromInput(runId: string | undefined): ReturnType<typeof createId> {
  if (runId === undefined) return createId("run");
  if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error("--run-id must match safe pattern run_[A-Za-z0-9_-]+.");
  }
  return runId as ReturnType<typeof createId>;
}

async function main(): Promise<void> {
  await runIntegrationDoctorCli();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
