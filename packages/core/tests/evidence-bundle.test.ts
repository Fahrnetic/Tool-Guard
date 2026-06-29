import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoreSession,
  createCoreApiServer,
  createId,
  exportEvidenceBundle,
  simulatePolicy,
  validateEvidenceBundleManifest,
  verifyIntegrationRoute,
  type CoreApiServerHandle,
  type CoreEvent
} from "../src/index.js";

const serverHandles: CoreApiServerHandle[] = [];

afterEach(async () => {
  await Promise.all(serverHandles.splice(0).map((handle) => handle.close()));
});

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

async function makeSeededSession(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const session = new CoreSession({ evidenceRoot: root, runId: createId("run") });
  await simulatePolicy({ session, scenarioId: "blocked-destructive", proposedPolicy: { destructiveAction: "block" } });
  await verifyIntegrationRoute({ session, routeType: "cli-supervised", workspaceRoot: path.resolve(".") });
  return { root, session };
}

describe("evidence bundle export", () => {
  it("exports a self-contained safe bundle with report, timeline, topology, ledger, policy, verification, hashes, redaction, and replay instructions", async () => {
    const { session } = await makeSeededSession("toolguard-bundle-safe-");

    const bundle = await exportEvidenceBundle({
      session,
      replaySafety: { fixtureOnly: true, safeLoopback: false }
    });

    expect(bundle.bundleDir).toBe(path.join(session.recorder.runDir, "bundle"));
    await expect(readFile(path.join(bundle.bundleDir, "report.html"), "utf8")).resolves.toContain(
      "ToolGuard Evidence Report"
    );
    await expect(readFile(path.join(bundle.bundleDir, "events.jsonl"), "utf8")).resolves.toContain("policy.simulated");
    await expect(readFile(path.join(bundle.bundleDir, "topology.json"), "utf8")).resolves.toContain("\"nodes\"");
    await expect(readFile(path.join(bundle.bundleDir, "ledger.jsonl"), "utf8")).resolves.toBeDefined();
    await expect(readFile(path.join(bundle.bundleDir, "blast-radius.json"), "utf8")).resolves.toContain(
      "explanations"
    );
    await expect(readFile(path.join(bundle.bundleDir, "retry-loops.json"), "utf8")).resolves.toContain("findings");
    await expect(readFile(path.join(bundle.bundleDir, "policy-simulator-result.json"), "utf8")).resolves.toContain(
      "blocked-destructive"
    );
    await expect(readFile(path.join(bundle.bundleDir, "integration-verification-receipts.json"), "utf8")).resolves.toContain(
      "cli-supervised"
    );
    await expect(readFile(path.join(bundle.bundleDir, "artifact-hashes.json"), "utf8")).resolves.toContain("sha256");
    await expect(readFile(path.join(bundle.bundleDir, "redaction-summary.json"), "utf8")).resolves.toContain(
      "redactionCount"
    );
    await expect(readFile(path.join(bundle.bundleDir, "replay-instructions.json"), "utf8")).resolves.toContain(
      "fixture-only"
    );

    const rawReadme = await readFile(path.join(bundle.bundleDir, "evidence", "raw-untrusted", "README.txt"), "utf8");
    expect(rawReadme).toMatch(/raw\/untrusted/i);
    expect(bundle.manifest.manifestValidation.valid).toBe(true);
    expect(bundle.validation.valid).toBe(true);

    const validation = await validateEvidenceBundleManifest({ bundleDir: bundle.bundleDir });
    expect(validation.valid).toBe(true);

    const events = await readJsonl<CoreEvent>(session.recorder.eventsPath);
    expect(events.at(-1)?.type).toBe("bundle.exported");
  });

  it("fails closed when bundle manifest hashes are missing or mismatched", async () => {
    const { session } = await makeSeededSession("toolguard-bundle-tamper-");
    const bundle = await exportEvidenceBundle({
      session,
      replaySafety: { fixtureOnly: true, safeLoopback: false }
    });

    await writeFile(path.join(bundle.bundleDir, "events.jsonl"), "{\"tampered\":true}\n", "utf8");
    await expect(validateEvidenceBundleManifest({ bundleDir: bundle.bundleDir })).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringMatching(/Hash mismatch for events\.jsonl/)])
    });

    const manifestPath = path.join(bundle.bundleDir, "manifest.json");
    const manifest = await readJson<{ artifactHashes: Array<{ relativePath: string; sha256?: string }> }>(manifestPath);
    delete manifest.artifactHashes[0]?.sha256;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(validateEvidenceBundleManifest({ bundleDir: bundle.bundleDir })).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringMatching(/Missing hash for/)])
    });
  });

  it("omits replay instructions for unsafe scenarios", async () => {
    const { session } = await makeSeededSession("toolguard-bundle-unsafe-");
    const bundle = await exportEvidenceBundle({
      session,
      replaySafety: { fixtureOnly: false, safeLoopback: false }
    });

    await expect(readFile(path.join(bundle.bundleDir, "replay-instructions.json"), "utf8")).rejects.toThrow();
    expect(bundle.manifest.replay.safe).toBe(false);
    expect(bundle.manifest.replay.instructionsFile).toBeUndefined();
  });

  it("serves bundle export from the Core API without network credentials", async () => {
    const { root, session } = await makeSeededSession("toolguard-bundle-api-");
    const handle = createCoreApiServer({ host: "127.0.0.1", port: 0, evidenceRoot: root, session });
    serverHandles.push(handle);
    await handle.ready;
    const address = handle.server.address();
    expect(typeof address).toBe("object");
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    const response = await fetch(`${baseUrl}/api/bundle/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replaySafety: { safeLoopback: true } })
    });
    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { bundleDir: string; manifestValid: boolean; replayInstructions?: string };
    expect(payload.bundleDir).toBe(path.join(session.recorder.runDir, "bundle"));
    expect(payload.manifestValid).toBe(true);
    expect(payload.replayInstructions).toMatch(/replay-instructions\.json$/);

    await rm(path.join(session.recorder.runDir, "bundle", "manifest-validation.json"), { force: true });
  });
});
