import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_DOCTOR_ROUTES,
  runIntegrationDoctor,
  type CoreEvent,
  type IntegrationRouteCoverageState
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
  it("emits MCP, CLI, and Python route receipts, smoke diagnostics, and hashed bundle entries", async () => {
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
    expect(events.filter((event) => event.type === "tool.call.failed").map((event) => event.summary)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("doctor.smoke.mcp-routed"),
        expect.stringContaining("doctor.smoke.cli-supervised"),
        expect.stringContaining("doctor.smoke.sdk-wrapped-python")
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

    const diagnostics = await readJson<{ failures: Array<{ toolName: string }> }>(
      path.join(bundleDir, "diagnostics.json")
    );
    const smokeDiagnostics = diagnostics.failures.filter((failure) => failure.toolName.startsWith("doctor.smoke."));
    expect(smokeDiagnostics.map((failure) => failure.toolName)).toEqual(
      expect.arrayContaining([
        "doctor.smoke.mcp-routed",
        "doctor.smoke.cli-supervised",
        "doctor.smoke.sdk-wrapped-python"
      ])
    );
    expect(smokeDiagnostics).toHaveLength(3);

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
