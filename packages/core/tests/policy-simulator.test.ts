import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoreSession,
  createCoreApiServer,
  createId,
  simulatePolicy,
  verifyIntegrationRoute,
  type CoreApiServerHandle,
  type CoreEvent,
  type IntegrationVerificationReceipt,
  type PolicySimulationResult
} from "../src/index.js";

const serverHandles: CoreApiServerHandle[] = [];

afterEach(async () => {
  await Promise.all(serverHandles.splice(0).map((handle) => handle.close()));
});

async function readJsonl<T>(filePath: string): Promise<T[]> {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

describe("policy simulator and integration verification core", () => {
  it("dry-runs recorded scenarios without executing downstream side effects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-policy-sim-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const observedSideEffects: string[] = [];

    const safe = await simulatePolicy({
      session,
      scenarioId: "safe-success",
      proposedPolicy: { retryLimit: 1, circuitFailureThreshold: 2 },
      sideEffectObserver: (effect) => observedSideEffects.push(effect)
    });
    const blocked = await simulatePolicy({
      session,
      scenarioId: "blocked-destructive",
      proposedPolicy: { destructiveAction: "block", retryLimit: 0 },
      sideEffectObserver: (effect) => observedSideEffects.push(effect)
    });
    const retryLoop = await simulatePolicy({
      session,
      scenarioId: "retry-loop-failure",
      proposedPolicy: { retryLimit: 2, circuitFailureThreshold: 2 },
      sideEffectObserver: (effect) => observedSideEffects.push(effect)
    });

    expect([safe.scenarioId, blocked.scenarioId, retryLoop.scenarioId]).toEqual([
      "safe-success",
      "blocked-destructive",
      "retry-loop-failure"
    ]);
    expect(observedSideEffects).toEqual([]);
    expect(new Set([...safe.previewDecisions, ...blocked.previewDecisions, ...retryLoop.previewDecisions])).toEqual(
      new Set(["allow", "block", "retry", "fail-fast", "open circuit", "close circuit"])
    );
    expect(blocked.blastRadius.before.score).toBeGreaterThan(blocked.blastRadius.after.score);
    expect(blocked.blastRadius.delta).toBe(blocked.blastRadius.after.score - blocked.blastRadius.before.score);
    expect(retryLoop.explanation).toMatch(/would/i);
    expect(retryLoop.dryRun.downstreamExecuted).toBe(false);

    const events = await readJsonl<CoreEvent>(session.recorder.eventsPath);
    expect(events.filter((event) => event.type === "policy.simulated")).toHaveLength(3);
    expect(events.filter((event) => event.type === "evidence.artifact.created").length).toBeGreaterThanOrEqual(3);
  });

  it("verifies MCP, Python, and CLI routes with local-only probes and receipt artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-verify-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });

    const receipts = [
      await verifyIntegrationRoute({ session, routeType: "mcp-routed" }),
      await verifyIntegrationRoute({ session, routeType: "sdk-wrapped-python" }),
      await verifyIntegrationRoute({ session, routeType: "cli-supervised" })
    ];

    expect(receipts.map((receipt) => receipt.routeType)).toEqual([
      "mcp-routed",
      "sdk-wrapped-python",
      "cli-supervised"
    ]);
    expect(receipts.every((receipt) => receipt.timestamp && receipt.checkedCapabilities.length >= 3)).toBe(true);
    expect(receipts.flatMap((receipt) => receipt.checkedCapabilities.map((capability) => capability.status))).not.toContain(
      "not-yet-verified"
    );
    expect(receipts.flatMap((receipt) => receipt.checkedCapabilities.map((capability) => capability.evidence))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Executed adapter import probe/),
        expect.stringMatching(/^Executed config generation probe/),
        expect.stringMatching(/^Executed MCP router probe/),
        expect.stringMatching(/^Executed Python adapter import probe/),
        expect.stringMatching(/^Executed Python loopback safety probe/),
        expect.stringMatching(/^Executed CLI process probe/),
        expect.stringMatching(/^Executed CLI argv probe/),
        expect.stringMatching(/^Executed CLI destructive guard probe/)
      ])
    );
    expect(receipts.flatMap((receipt) => receipt.checkedCapabilities.map((capability) => capability.capability))).toEqual(
      expect.arrayContaining([
        "adapter availability",
        "config snippet validity",
        "tool exposure",
        "sidecar compatibility",
        "loopback URL safety",
        "process probe",
        "argv boundary",
        "destructive guard"
      ])
    );
    expect(receipts.every((receipt) => receipt.limitation.includes("only"))).toBe(true);
    expect(receipts.every((receipt) => receipt.evidenceLinks.length > 0)).toBe(true);

    const events = await readJsonl<CoreEvent>(session.recorder.eventsPath);
    expect(events.filter((event) => event.type === "integration.verified")).toHaveLength(3);
    expect(events.filter((event) => event.type === "evidence.artifact.created").length).toBeGreaterThanOrEqual(3);
  });

  it("serves simulation and verification over Core API endpoints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-policy-api-"));
    const session = new CoreSession({ evidenceRoot: root, runId: createId("run") });
    const handle = createCoreApiServer({ host: "127.0.0.1", port: 0, evidenceRoot: root, session });
    serverHandles.push(handle);
    await handle.ready;
    const address = handle.server.address();
    expect(typeof address).toBe("object");
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    const simulation = await postJson<PolicySimulationResult>(`${baseUrl}/api/policy/simulate`, {
      scenarioId: "blocked-destructive",
      proposedPolicy: { destructiveAction: "block" }
    });
    const verification = await postJson<IntegrationVerificationReceipt>(`${baseUrl}/api/integrations/verify`, {
      routeType: "cli-supervised"
    });

    expect(simulation.previewDecisions).toContain("block");
    expect(simulation.dryRun.downstreamExecuted).toBe(false);
    expect(verification.routeType).toBe("cli-supervised");
    expect(verification.checkedCapabilities.map((capability) => capability.capability)).toEqual(
      expect.arrayContaining(["process probe", "argv boundary", "destructive guard"])
    );
  });
});
