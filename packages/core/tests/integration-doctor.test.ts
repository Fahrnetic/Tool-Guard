import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CoreSession,
  INTEGRATION_DOCTOR_ROUTES,
  createCoreApiServer,
  createId,
  runIntegrationDoctor,
  type CoreEvent,
  type IntegrationVerificationReceipt,
  type IntegrationRouteCoverageState,
  type StableId
} from "../src/index.js";

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

describe("integration doctor route coverage", () => {
  it("emits host/platform/transport passports and honest unsupported native coverage", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-platform-passports-"));
    const result = await runIntegrationDoctor({
      evidenceRoot,
      workspaceRoot: path.resolve("."),
      runId: "run_platform_passport_seed",
      probeTimeoutMs: 10_000
    });

    for (const receipt of result.receipts) {
      expect(receipt).toMatchObject({
        hostId: expect.any(String),
        osPlatform: process.platform,
        transport: expect.any(String),
        routeType: expect.any(String),
        configHash: expect.stringMatching(/^(fnv1a|route)-[a-f0-9]{8,64}$/),
        visibilityLevel: expect.stringMatching(/^(mediated|supervised|observed)$/),
        limitations: expect.arrayContaining([expect.stringMatching(/not|only|direct|native|process/i)]),
        evidenceFields: expect.arrayContaining(["receiptId", "routeType", "checkedCapabilities", "evidenceLinks"]),
        smokeTestStatus: expect.stringMatching(/^(passed|failed)$/),
        lastVerifiedAt: expect.stringMatching(/T/)
      });
      expect(receipt.platformPassport).toMatchObject({
        hostId: receipt.hostId,
        osPlatform: process.platform,
        transport: receipt.transport,
        routeType: receipt.routeType,
        configHash: receipt.configHash,
        visibilityLevel: receipt.visibilityLevel,
        limitations: receipt.limitations,
        evidenceFields: receipt.evidenceFields,
        smokeTestStatus: receipt.smokeTestStatus,
        lastVerifiedAt: receipt.lastVerifiedAt
      });
      expect(receipt.nativeHostActions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: expect.stringMatching(/native host/i),
            coverage: expect.stringMatching(/^(not-covered|observed-only)$/),
            limitation: expect.stringMatching(/route|bypass|native/i)
          })
        ])
      );
    }
  }, 40_000);

  it("reloads persisted coverage history across Core sessions and warns on stale evidence", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-platform-history-"));
    const firstSession = new CoreSession({ evidenceRoot, runId: createId("run") });
    const staleReceipt = makeStaleMcpReceipt(firstSession.runId);
    const staleEvent = await firstSession.emitIntegrationVerified(staleReceipt);
    await firstSession.recorder.appendEvent({
      ...staleEvent,
      occurredAt: "2000-01-01T00:00:00.000Z"
    });
    await firstSession.recorder.flushRunIndex();

    const handle = createCoreApiServer({ host: "127.0.0.1", port: 0, evidenceRoot, seedDirectRun: false });
    await handle.ready;
    const address = handle.server.address();
    expect(typeof address).toBe("object");
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const response = await fetch(`${baseUrl}/api/integrations`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        coverageHistory: Array<{ receiptId: string; evidenceFreshness: string; warning?: string }>;
        routeCoverage: Array<{ routeType: string; evidenceFreshness: string; warning?: string }>;
      };
      expect(payload.coverageHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            receiptId: staleReceipt.receiptId,
            evidenceFreshness: "stale",
            warning: expect.stringMatching(/older|stale|re-run/i)
          })
        ])
      );
      expect(payload.routeCoverage.find((row) => row.routeType === "mcp-routed")).toMatchObject({
        evidenceFreshness: "stale",
        warning: expect.stringMatching(/older|stale|re-run/i)
      });
    } finally {
      await handle.close();
    }
  });

  it("emits MCP, CLI, and Python route receipts with real routed probe evidence and hashed bundle entries", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-integration-doctor-"));
    const result = await runIntegrationDoctor({
      evidenceRoot,
      workspaceRoot: path.resolve("."),
      runId: "run_doctor_test_seed",
      probeTimeoutMs: 10_000
    });

    expect(result.receipts.map((receipt) => receipt.routeType)).toEqual(INTEGRATION_DOCTOR_ROUTES);
    expect(result.bundleValid).toBe(true);
    for (const receipt of result.receipts) {
      const states = receipt.routeCoverage.map((entry) => entry.state);
      expect(states).toEqual(
        expect.arrayContaining<IntegrationRouteCoverageState>([
          "configured",
          "available",
          "unsupported",
          "not-verified",
          "producing-evidence"
        ])
      );
      expect(receipt.routeCoverage.find((entry) => entry.state === "unsupported")?.evidence).toMatch(/only|not intercepted/i);
      expect(receipt.routeCoverage.find((entry) => entry.state === "producing-evidence")?.evidence).toMatch(
        /evidence artifact/i
      );
      expect(receipt.evidenceLinks).not.toHaveLength(0);
    }

    const events = await readJsonl<CoreEvent>(result.eventsPath);
    expect(events.filter((event) => event.type === "integration.verified")).toHaveLength(3);
    expect(events.filter((event) => event.type === "tool.call.failed").map((event) => event.summary)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("doctor.smoke.")])
    );
    expect(result.receipts.flatMap((receipt) => receipt.checkedCapabilities.map((capability) => capability.evidence))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Executed MCP virtual routed tool probe/),
        expect.stringMatching(/^Executed Python wrapper sidecar route/),
        expect.stringMatching(/^Executed CLI process probe/)
      ])
    );

    const bundleDir = path.dirname(result.bundleManifest);
    const receiptsFile = await readJson<{
      receipts: Array<{ routeType: string; routeCoverage: Array<{ state: string }> }>;
    }>(path.join(bundleDir, "integration-verification-receipts.json"));
    expect(receiptsFile.receipts.map((receipt) => receipt.routeType)).toEqual(INTEGRATION_DOCTOR_ROUTES);
    expect(receiptsFile.receipts.flatMap((receipt) => receipt.routeCoverage.map((entry) => entry.state))).toEqual(
      expect.arrayContaining(["producing-evidence", "unsupported", "not-verified"])
    );

    const diagnostics = await readJson<{ failures: Array<{ toolName: string }> }>(path.join(bundleDir, "diagnostics.json"));
    expect(diagnostics.failures.some((failure) => failure.toolName.startsWith("doctor.smoke."))).toBe(false);

    const manifest = await readJson<{ artifactHashes: Array<{ relativePath: string; sha256: string }> }>(
      result.bundleManifest
    );
    expect(manifest.artifactHashes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "integration-verification-receipts.json" }),
        expect.objectContaining({ relativePath: "diagnostics.json" })
      ])
    );
    expect(
      manifest.artifactHashes.find((entry) => entry.relativePath === "integration-verification-receipts.json")?.sha256
    ).toMatch(/^[a-f0-9]{64}$/);
  }, 40_000);
});

function makeStaleMcpReceipt(runId: StableId): IntegrationVerificationReceipt {
  return {
    receiptId: createId("receipt"),
    runId,
    timestamp: "2000-01-01T00:00:00.000Z",
    routeType: "mcp-routed",
    integrationId: "cline",
    hostId: "cline",
    hostFamily: "cline-roo-style",
    supportedHostIds: ["cline"],
    osPlatform: process.platform,
    osFamily: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    transport: "stdio",
    configHash: "route-00000000",
    visibilityLevel: "mediated",
    limitations: ["Native host tools that bypass the MCP route are not covered."],
    evidenceFields: ["receiptId", "routeType", "checkedCapabilities", "evidenceLinks"],
    smokeTestStatus: "passed",
    lastVerifiedAt: "2000-01-01T00:00:00.000Z",
    platformPassport: {
      passportId: "passport_cline_stale",
      hostId: "cline",
      hostName: "Cline",
      osPlatform: process.platform,
      osFamily: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
      transport: "stdio",
      routeType: "mcp-routed",
      configHash: "route-00000000",
      visibilityLevel: "mediated",
      limitations: ["Native host tools that bypass the MCP route are not covered."],
      evidenceFields: ["receiptId", "routeType", "checkedCapabilities", "evidenceLinks"],
      smokeTestStatus: "passed",
      lastVerifiedAt: "2000-01-01T00:00:00.000Z"
    },
    nativeHostActions: [
      {
        action: "Native host tool calls that bypass ToolGuard",
        coverage: "not-covered",
        limitation: "No ToolGuard route observes or mediates these calls."
      }
    ],
    checkedCapabilities: [
      {
        capability: "virtual routed tool evidence",
        status: "available",
        localOnly: true,
        evidence: "Executed stale Cline-specific virtual routed tool evidence probe."
      }
    ],
    routeCoverage: [
      {
        state: "producing-evidence",
        label: "MCP routed adapter path producing evidence",
        localOnly: true,
        evidence: "The stale Cline host-specific route produced evidence."
      }
    ],
    limitation: "Local-only MCP verification checks calls routed through ToolGuard MCP configuration only.",
    evidenceLinks: []
  };
}
