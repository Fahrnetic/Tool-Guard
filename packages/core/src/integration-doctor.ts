import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CoreSession } from "./session.js";
import { createId } from "./ids.js";
import { exportEvidenceBundle } from "./bundle.js";
import { verifyIntegrationRoute } from "./integration-verification.js";
import type { IntegrationRouteType, IntegrationVerificationReceipt } from "./types.js";

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

function createIdFromInput(runId: string | undefined): ReturnType<typeof createId> {
  return runId === undefined ? createId("run") : (runId as ReturnType<typeof createId>);
}

async function main(): Promise<void> {
  const result = await runIntegrationDoctor();
  console.log("ToolGuard integration doctor");
  console.log(`runId: ${result.runId}`);
  console.log(`evidenceDir: ${result.evidenceDir}`);
  console.log(`eventsJsonl: ${result.eventsPath}`);
  console.log(`bundleManifest: ${result.bundleManifest}`);
  console.log(`bundleValid: ${String(result.bundleValid)}`);
  for (const receipt of result.receipts) {
    const capabilityStates = receipt.checkedCapabilities
      .map((capability) => `${capability.capability}=${capability.status}`)
      .join(", ");
    const coverageStates = receipt.routeCoverage.map((entry) => entry.state).join(", ");
    console.log(`receipt: ${receipt.routeType}`);
    console.log(`  receiptId: ${receipt.receiptId}`);
    console.log(`  capabilities: ${capabilityStates}`);
    console.log(`  coverage: ${coverageStates}`);
    console.log(`  limitation: ${receipt.limitation}`);
    console.log(`  evidenceLinks: ${receipt.evidenceLinks.map((link) => link.href).join(", ")}`);
  }
  if (!result.bundleValid) {
    throw new Error(`Integration doctor bundle validation failed: ${result.validationErrors.join("; ")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
