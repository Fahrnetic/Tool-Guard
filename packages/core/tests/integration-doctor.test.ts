import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CoreSession,
  INTEGRATION_DOCTOR_ROUTES,
  buildIntegrationDoctorJson,
  createCoreApiServer,
  createId,
  renderIntegrationDoctorHuman,
  runIntegrationDoctor,
  verifyIntegrationRoute,
  type CoreEvent,
  type EvidenceLink,
  type HostPlatformPassport,
  type IntegrationVerificationReceipt,
  type IntegrationRouteCoverageState,
  type StableId,
  type ToolCall
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
  it("scopes verification receipts to the selected non-default MCP host and platform", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-selected-mcp-receipt-"));
    const session = new CoreSession({ evidenceRoot, runId: "run_selected_roo_mcp" as StableId });

    const receipt = await verifyIntegrationRoute({
      session,
      routeType: "mcp-routed",
      integrationId: "roo-code",
      hostId: "roo-code",
      hostName: "Roo Code",
      hostFamily: "cline-roo-style",
      supportedHostIds: ["roo-code"],
      platform: "powershell",
      transport: "stdio",
      configHash: "fnv1a-roo-selected",
      workspaceRoot: path.resolve("."),
      probeTimeoutMs: 10_000
    });

    expect(receipt.integrationId).toBe("roo-code");
    expect(receipt.hostId).toBe("roo-code");
    expect(receipt.supportedHostIds).toEqual(["roo-code"]);
    expect(receipt.osPlatform).toBe("powershell");
    expect(receipt.transport).toBe("stdio");
    expect(receipt.configHash).toBe("fnv1a-roo-selected");
    expect(receipt.platformPassport).toEqual(
      expect.objectContaining({
        hostId: "roo-code",
        hostName: "Roo Code",
        osPlatform: "powershell",
        transport: "stdio",
        configHash: "fnv1a-roo-selected"
      })
    );
    expect(receipt.evidenceLinks[0]).toEqual(
      expect.objectContaining({
        hostId: "roo-code",
        configHash: "fnv1a-roo-selected"
      })
    );
    expect(receipt.hostId).not.toBe("cline");
  }, 20_000);

  it("builds a stable no-secret machine JSON schema with route passports and CI receipt paths", () => {
    const receipt = makeDoctorReceipt({
      runId: "run_doctor_json_seed" as StableId,
      routeType: "cli-supervised",
      capabilityStatus: "available",
      coverageStates: ["configured", "available", "unsupported", "not-verified", "producing-evidence"]
    });
    const output = buildIntegrationDoctorJson(
      {
        runId: receipt.runId,
        evidenceDir: "/tmp/toolguard-doctor/run_doctor_json_seed",
        eventsPath: "/tmp/toolguard-doctor/run_doctor_json_seed/events.jsonl",
        receipts: [receipt],
        bundleManifest: "/tmp/toolguard-doctor/run_doctor_json_seed/bundle/manifest.json",
        bundleValid: true,
        validationErrors: []
      },
      "2026-07-01T00:00:00.000Z"
    );

    expect(output).toMatchObject({
      schemaVersion: "toolguard.integration-doctor.v1",
      kind: "toolguard.integrationDoctor",
      noSecrets: {
        status: "passed",
        redactionsApplied: 0
      },
      artifactBundle: {
        valid: true,
        localOnly: true,
        requiresExternalCredentials: false
      },
      ci: {
        githubActionsCompatible: true,
        requiresExternalCredentials: false
      }
    });
    expect(output.routes[0]!).toMatchObject({
      routeType: "cli-supervised",
      passport: expect.objectContaining({
        passportId: "passport_local_cli_supervised",
        visibilityLevel: "supervised"
      }),
      checkedCapabilities: expect.arrayContaining([expect.objectContaining({ capability: "pass probe", status: "available" })]),
      routeCoverage: expect.arrayContaining([
        expect.objectContaining({ state: "unsupported" }),
        expect.objectContaining({ state: "not-verified" }),
        expect.objectContaining({ state: "producing-evidence" })
      ]),
      evidenceLinks: expect.arrayContaining([
        expect.objectContaining({ href: "artifacts/integration-verification-cli-supervised-receipt.json", routeType: "cli-supervised" })
      ])
    });
    expect(output.ci.workflowSnippet.join("\n")).toContain("pnpm --silent doctor:integrations -- --json");
    expect(output.ci.artifactPaths).toEqual(
      expect.arrayContaining([
        "/tmp/toolguard-doctor/run_doctor_json_seed/events.jsonl",
        "/tmp/toolguard-doctor/run_doctor_json_seed/bundle/integration-verification-receipts.json",
        "/tmp/toolguard-doctor/run_doctor_json_seed/bundle/manifest.json"
      ])
    );
    expect(JSON.stringify(output)).not.toMatch(/sk-[A-Za-z0-9]|Bearer\s+|BEGIN PRIVATE KEY|token=[A-Za-z0-9]{20,}/);
  });

  it("keeps human doctor text distinct from machine JSON and represents failure cases safely", () => {
    const failedReceipt = makeDoctorReceipt({
      runId: "run_doctor_failure_seed" as StableId,
      routeType: "mcp-routed",
      capabilityStatus: "not-yet-verified",
      coverageStates: ["configured", "unsupported", "not-verified"]
    });
    const result = {
      runId: failedReceipt.runId,
      evidenceDir: "/tmp/toolguard-doctor/run_doctor_failure_seed",
      eventsPath: "/tmp/toolguard-doctor/run_doctor_failure_seed/events.jsonl",
      receipts: [failedReceipt],
      bundleManifest: "/tmp/toolguard-doctor/run_doctor_failure_seed/bundle/manifest.json",
      bundleValid: false,
      validationErrors: ["missing artifact hash for route receipt"]
    };

    const human = renderIntegrationDoctorHuman(result);
    const machine = buildIntegrationDoctorJson(result, "2026-07-01T00:00:00.000Z");

    expect(human).toContain("humanOutput: true");
    expect(human).toContain("machineJson: rerun with --json");
    expect(human.trim()).not.toMatch(/^\{/);
    expect(machine.artifactBundle.valid).toBe(false);
    expect(machine.artifactBundle.validationErrors).toEqual(["missing artifact hash for route receipt"]);
    expect(machine.routes[0]!.checkedCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "not-yet-verified",
          evidence: expect.stringMatching(/did not pass/i)
        })
      ])
    );
    expect(machine.receipts[0]!.producingEvidence).toBe(false);
  });

  it("keeps failed route probes as generic receipt artifacts without route-scoped evidence claims", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-failed-route-evidence-"));
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-empty-workspace-"));
    const session = new CoreSession({ evidenceRoot, runId: "run_failed_route_probe" as StableId });

    const receipt = await verifyIntegrationRoute({
      session,
      routeType: "mcp-routed",
      workspaceRoot,
      probeTimeoutMs: 25
    });
    const machine = buildIntegrationDoctorJson(
      {
        runId: receipt.runId,
        evidenceDir: session.recorder.runDir,
        eventsPath: session.recorder.eventsPath,
        receipts: [receipt],
        bundleManifest: path.join(session.recorder.runDir, "bundle", "manifest.json"),
        bundleValid: true,
        validationErrors: []
      },
      "2026-07-01T00:00:00.000Z"
    );

    expect(receipt.smokeTestStatus).toBe("failed");
    expect(receipt.checkedCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "virtual routed tool evidence",
          status: "not-yet-verified"
        })
      ])
    );
    expect(receipt.evidenceLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeType: "mcp-routed",
          evidenceScope: "host-config"
        })
      ])
    );
    expect(receipt.evidenceLinks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeType: "mcp-routed",
          evidenceScope: "route"
        })
      ])
    );
    expect(receipt.routeCoverage.find((entry) => entry.state === "producing-evidence")?.evidence).toMatch(
      /No exact route-specific smoke\/evidence probe passed/i
    );
    expect(machine.receipts[0]).toMatchObject({
      routeType: "mcp-routed",
      producingEvidence: false,
      smokeTestStatus: "failed"
    });
  });

  it("rejects unsafe doctor run IDs before evidence recorder path construction and accepts safe run IDs", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-doctor-run-id-"));
    await expect(
      runIntegrationDoctor({
        evidenceRoot,
        workspaceRoot: path.resolve("."),
        runId: "run_../escape",
        probeTimeoutMs: 25
      })
    ).rejects.toThrow(/--run-id must match safe pattern/);
    await expect(
      runIntegrationDoctor({
        evidenceRoot,
        workspaceRoot: await mkdtemp(path.join(tmpdir(), "toolguard-safe-run-id-workspace-")),
        runId: "run_safe-ABC_123",
        probeTimeoutMs: 25
      })
    ).resolves.toMatchObject({
      runId: "run_safe-ABC_123",
      evidenceDir: path.join(evidenceRoot, "run_safe-ABC_123")
    });
  }, 40_000);

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

  it("represents direct CoreSession and loopback API proof as one canonical Direct Core/API route", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-direct-core-api-"));
    const session = new CoreSession({ evidenceRoot, runId: "run_direct_core_api_seed" as StableId });
    const call = makeDirectCoreApiCall(session.runId);

    await session.mediateSuccessfulCall(call, { ok: true });
    const handle = createCoreApiServer({ host: "127.0.0.1", port: 0, evidenceRoot, session, seedDirectRun: false });
    await handle.ready;
    const address = handle.server.address();
    expect(typeof address).toBe("object");
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const response = await fetch(`${baseUrl}/api/integrations`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        routeInventory: Array<{ id: string; setupSnippetRoutes?: string[] }>;
        routeCoverage: Array<Record<string, unknown>>;
        integrations: Array<Record<string, unknown>>;
        setupMetadata: { snippets: Array<{ route: string; canonicalInventoryId: string }> };
      };
      expect(payload.routeInventory.filter((entry) => entry.id === "direct-core-api")).toHaveLength(1);
      expect(payload.routeCoverage.filter((entry) => entry.routeType === "direct-core-api")).toHaveLength(1);
      expect(payload.routeCoverage.find((entry) => entry.routeType === "direct-core-api")).toMatchObject({
        inventoryId: "direct-core-api",
        claim: "mediated",
        visibilityLevel: "mediated",
        coverageClaim: "mediated",
        evidenceScope: "route",
        configured: true,
        available: true,
        producingEvidence: true,
        setupSnippetRoutes: ["shell-api"],
        transports: ["in-process-core", "http-loopback-api"]
      });
      expect(payload.integrations.find((entry) => entry.id === "direct-core-api")).toMatchObject({
        claimLevel: "available",
        status: "available",
        setupSnippetRoutes: ["shell-api"]
      });
      expect(payload.setupMetadata.snippets.filter((snippet) => snippet.route === "shell-api")).toEqual([
        expect.objectContaining({ canonicalInventoryId: "direct-core-api" })
      ]);
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
      expect(receipt.routeCoverage.find((entry) => entry.state === "producing-evidence")?.evidence).toMatch(/evidence artifact/i);
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

    const manifest = await readJson<{ artifactHashes: Array<{ relativePath: string; sha256: string }> }>(result.bundleManifest);
    expect(manifest.artifactHashes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "integration-verification-receipts.json" }),
        expect.objectContaining({ relativePath: "diagnostics.json" })
      ])
    );
    expect(manifest.artifactHashes.find((entry) => entry.relativePath === "integration-verification-receipts.json")?.sha256).toMatch(
      /^[a-f0-9]{64}$/
    );
  }, 40_000);
});

function makeDoctorReceipt(input: {
  readonly runId: StableId;
  readonly routeType: IntegrationVerificationReceipt["routeType"];
  readonly capabilityStatus: IntegrationVerificationReceipt["checkedCapabilities"][number]["status"];
  readonly coverageStates: readonly IntegrationRouteCoverageState[];
}): IntegrationVerificationReceipt {
  const evidenceLink: EvidenceLink = {
    artifactId: "artifact_route_receipt" as StableId,
    href: `artifacts/integration-verification-${input.routeType}-receipt.json`,
    label: `Verification receipt for ${input.routeType}`,
    routeType: input.routeType,
    evidenceScope: "route",
    hostId: input.routeType === "mcp-routed" ? "cline" : "local-cli",
    configHash: "route-1234abcd"
  };
  const passport: HostPlatformPassport = {
    passportId: input.routeType === "mcp-routed" ? "passport_cline_mcp_routed" : "passport_local_cli_supervised",
    hostId: input.routeType === "mcp-routed" ? "cline" : "local-cli",
    hostName: input.routeType === "mcp-routed" ? "Cline" : "Local CLI wrapper",
    osPlatform: process.platform,
    osFamily: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    transport: input.routeType === "mcp-routed" ? "stdio" : "process-argv",
    routeType: input.routeType,
    configHash: "route-1234abcd",
    visibilityLevel: input.routeType === "mcp-routed" ? "mediated" : "supervised",
    limitations: ["Native host tools that bypass this route are not covered."],
    evidenceFields: ["receiptId", "routeType", "checkedCapabilities", "routeCoverage", "evidenceLinks", "platformPassport"],
    smokeTestStatus: input.capabilityStatus === "not-yet-verified" ? "failed" : "passed",
    lastVerifiedAt: "2026-07-01T00:00:00.000Z"
  };
  return {
    receiptId: "receipt_doctor_json" as StableId,
    runId: input.runId,
    timestamp: "2026-07-01T00:00:00.000Z",
    routeType: input.routeType,
    hostId: passport.hostId,
    configHash: passport.configHash,
    osPlatform: passport.osPlatform,
    osFamily: passport.osFamily,
    transport: passport.transport,
    visibilityLevel: passport.visibilityLevel,
    limitations: passport.limitations,
    evidenceFields: passport.evidenceFields,
    smokeTestStatus: passport.smokeTestStatus,
    lastVerifiedAt: passport.lastVerifiedAt,
    platformPassport: passport,
    nativeHostActions: [
      {
        action: "Native host tool calls that bypass ToolGuard",
        coverage: "not-covered",
        limitation: "Native host actions that bypass this route are not covered."
      }
    ],
    checkedCapabilities: [
      {
        capability: input.capabilityStatus === "not-yet-verified" ? "failure probe" : "pass probe",
        status: input.capabilityStatus,
        localOnly: true,
        evidence:
          input.capabilityStatus === "not-yet-verified"
            ? "Local probe executed but did not pass: fixture failure"
            : "Executed route probe successfully."
      }
    ],
    routeCoverage: input.coverageStates.map((state) => ({
      state,
      label: `${input.routeType} ${state}`,
      localOnly: true,
      evidence: state === "unsupported" ? "Native host tools are not intercepted by this route." : `${state} evidence`
    })),
    limitation: "Local-only verification checks routed ToolGuard evidence only.",
    evidenceLinks: [evidenceLink]
  };
}

function makeDirectCoreApiCall(runId: StableId): ToolCall {
  return {
    runId,
    traceId: createId("trace"),
    harnessId: createId("harness"),
    harnessName: "Direct Core/API proof",
    adapterId: createId("adapter"),
    adapterName: "CoreSession",
    downstreamServerId: createId("server"),
    toolCallId: createId("toolcall"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName: "fixture.direct-core-api",
    arguments: { message: "direct-core-api-ok" },
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    routeMetadata: {
      routeType: "direct-core-api",
      routeId: "direct-core-api",
      downstreamTargetIdentity: "CoreSession",
      endpoint: {
        protocol: "http",
        host: "127.0.0.1",
        port: 0,
        path: "/api/integrations"
      },
      transport: {
        kind: "in-process-core"
      },
      coverage: {
        claim: "mediated",
        evidenceScope: "route",
        producingEvidence: true
      }
    }
  };
}

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
