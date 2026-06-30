import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoreSession,
  createCoreApiServer,
  createId,
  exportEvidenceBundle,
  registerChaosFixtures,
  simulatePolicy,
  ToolRegistry,
  validateEvidenceBundleManifest,
  verifyIntegrationRoute,
  type EvidenceArtifact,
  type CoreApiServerHandle,
  type CoreEvent,
  type ToolCall
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

function makeToolCall(runId: ToolCall["runId"]): ToolCall {
  return {
    runId,
    traceId: createId("trace"),
    parentId: createId("parent"),
    harnessId: createId("harness"),
    adapterId: createId("adapter"),
    downstreamServerId: createId("server"),
    toolCallId: createId("toolcall"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName: "fixture.echo",
    arguments: {},
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct"
  };
}

describe("evidence bundle export", () => {
  it("exports a self-contained safe bundle with report, timeline, topology, ledger, policy, verification, hashes, redaction, and replay instructions", async () => {
    const { session } = await makeSeededSession("toolguard-bundle-safe-");
    const registry = new ToolRegistry();
    registerChaosFixtures(registry, { sandboxRoot: session.recorder.runDir });
    await session.executeToolCall(registry, {
      ...makeToolCall(session.runId),
      downstreamServerId: registry.get("fixture.destructive-block")?.downstreamServerId ?? createId("server"),
      toolName: "fixture.destructive-block",
      arguments: { fixtureOnly: true }
    });

    const bundle = await exportEvidenceBundle({
      session,
      replaySafety: { fixtureOnly: false, safeLoopback: false }
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
    await expect(readFile(path.join(bundle.bundleDir, "artifact-hashes.json"), "utf8")).resolves.toContain("manifest-validation.json");
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
    const manifest = await readJson<{ files: { manifestValidationJson?: string }; artifactHashes: Array<{ relativePath: string }> }>(bundle.manifestPath);
    expect(manifest.files.manifestValidationJson).toBe("manifest-validation.json");
    expect(manifest.artifactHashes).toEqual(
      expect.arrayContaining([expect.objectContaining({ relativePath: "manifest-validation.json" })])
    );

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

  it("covers diagnostic workbench trust files, replay recipes, and reproducibility checks in bundle integrity", async () => {
    const { session } = await makeSeededSession("toolguard-bundle-trust-");
    await session.failToolCall(makeToolCall(session.runId), "non_zero_exit", [
      "safe failing command output",
      `Bearer ${"C".repeat(32)}`
    ]);

    const bundle = await exportEvidenceBundle({
      session,
      replaySafety: { fixtureOnly: true }
    });

    const manifest = await readJson<{
      files: {
        contextMetricsJson: string;
        diagnosticsJson: string;
        issuePacketMd: string;
        replayRecipesJson: string;
        reproducibilityJson: string;
      };
      trust: {
        integrityCoveredFiles: string[];
        containedLinksOnly: boolean;
        safeFieldsExcludeRawOutput: boolean;
      };
    }>(bundle.manifestPath);

    expect(manifest.files).toMatchObject({
      contextMetricsJson: "context-metrics.json",
      diagnosticsJson: "diagnostics.json",
      issuePacketMd: "issue-packet.md",
      replayRecipesJson: "replay-recipes.json",
      reproducibilityJson: "reproducibility-checks.json"
    });
    expect(manifest.trust.integrityCoveredFiles).toEqual(
      expect.arrayContaining([
        "events.jsonl",
        "ledger.jsonl",
        "context-metrics.json",
        "diagnostics.json",
        "issue-packet.md",
        "topology.json",
        "replay-recipes.json"
      ])
    );
    expect(manifest.trust.containedLinksOnly).toBe(true);
    expect(manifest.trust.safeFieldsExcludeRawOutput).toBe(true);

    const contextMetrics = await readJson<{ failures: Array<{ contextImpact: unknown }> }>(
      path.join(bundle.bundleDir, "context-metrics.json")
    );
    const diagnostics = await readJson<{ failures: Array<{ evidenceAnchors: unknown[] }> }>(
      path.join(bundle.bundleDir, "diagnostics.json")
    );
    const replayRecipes = await readJson<{ recipes: Array<{ safetyClass: string; executable: boolean }> }>(
      path.join(bundle.bundleDir, "replay-recipes.json")
    );
    const reproducibility = await readJson<{ checks: Array<{ name: string; status: string }> }>(
      path.join(bundle.bundleDir, "reproducibility-checks.json")
    );
    const issuePacket = await readFile(path.join(bundle.bundleDir, "issue-packet.md"), "utf8");

    expect(contextMetrics.failures[0]?.contextImpact).toBeDefined();
    expect(JSON.stringify(contextMetrics)).not.toContain("C".repeat(32));
    expect(diagnostics.failures[0]?.evidenceAnchors.length).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostics)).not.toContain("C".repeat(32));
    expect(replayRecipes.recipes.map((recipe) => recipe.safetyClass)).toEqual(
      expect.arrayContaining(["fixture replay", "loopback replay", "real-command dry-run", "not replayable"])
    );
    expect(replayRecipes.recipes.find((recipe) => recipe.safetyClass === "not replayable")?.executable).toBe(false);
    expect(reproducibility.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(["cwd", "packageManager", "routeConfigHash", "fixtureSeed"])
    );
    expect(issuePacket).toContain("ToolGuard issue packet");
    expect(issuePacket).not.toContain("C".repeat(32));

    const validation = await validateEvidenceBundleManifest({ bundleDir: bundle.bundleDir });
    expect(validation.valid).toBe(true);
  });

  it("reports missing diagnostic artifacts, contained-link violations, and reproducibility mismatches", async () => {
    const { session } = await makeSeededSession("toolguard-bundle-warnings-");
    const bundle = await exportEvidenceBundle({
      session,
      replaySafety: { fixtureOnly: true }
    });

    await rm(path.join(bundle.bundleDir, "context-metrics.json"), { force: true });
    await expect(validateEvidenceBundleManifest({ bundleDir: bundle.bundleDir })).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringMatching(/context-metrics\.json/)])
    });

    const fresh = await exportEvidenceBundle({
      session,
      replaySafety: { fixtureOnly: true }
    });
    await writeFile(
      path.join(fresh.bundleDir, "issue-packet.md"),
      "# unsafe\n\n[escape](file:///tmp/outside)\n",
      "utf8"
    );
    await expect(validateEvidenceBundleManifest({ bundleDir: fresh.bundleDir })).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringMatching(/unsafe link/i)])
    });

    const reproFresh = await exportEvidenceBundle({
      session,
      replaySafety: { fixtureOnly: true }
    });
    const reproducibilityPath = path.join(reproFresh.bundleDir, "reproducibility-checks.json");
    const reproducibility = await readJson<{ checks: Array<Record<string, unknown>> }>(reproducibilityPath);
    await writeFile(
      reproducibilityPath,
      `${JSON.stringify(
        {
          ...reproducibility,
          expected: { ...(reproducibility as { expected?: Record<string, unknown> }).expected, fixtureSeed: "changed-seed" },
          checks: reproducibility.checks.map((check) =>
            check.name === "fixtureSeed" ? { ...check, expected: "changed-seed", status: "mismatch" } : check
          )
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await expect(validateEvidenceBundleManifest({ bundleDir: reproFresh.bundleDir })).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringMatching(/Reproducibility mismatch for fixtureSeed/)])
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

  it("ignores caller-forged replay safety and derives fixture safety from recorded evidence", async () => {
    const { session: unsafeSession } = await makeSeededSession("toolguard-bundle-forged-unsafe-");
    const forged = await exportEvidenceBundle({
      session: unsafeSession,
      replaySafety: { fixtureOnly: true, safeLoopback: true }
    });

    expect(forged.manifest.replay.safe).toBe(false);
    expect(forged.manifest.replay.reason).toMatch(/server-derived/i);
    expect(forged.manifest.replay.instructionsFile).toBeUndefined();
    await expect(readFile(path.join(forged.bundleDir, "replay-instructions.json"), "utf8")).rejects.toThrow();

    const safeRoot = await mkdtemp(path.join(tmpdir(), "toolguard-bundle-derived-fixture-"));
    const safeSession = new CoreSession({ evidenceRoot: safeRoot, runId: createId("run") });
    const registry = new ToolRegistry();
    registerChaosFixtures(registry, { sandboxRoot: safeRoot });
    await safeSession.executeToolCall(registry, {
      ...makeToolCall(safeSession.runId),
      downstreamServerId: registry.get("fixture.destructive-block")?.downstreamServerId ?? createId("server"),
      toolName: "fixture.destructive-block",
      arguments: { fixtureOnly: true }
    });

    const derived = await exportEvidenceBundle({
      session: safeSession,
      replaySafety: { fixtureOnly: false, safeLoopback: false }
    });
    expect(derived.manifest.replay.safe).toBe(true);
    expect(derived.manifest.replay.reason).toMatch(/server-derived fixture-only/i);
    expect(derived.manifest.replay.instructionsFile).toBe("replay-instructions.json");
  });

  it("derives routeConfigHash from recorded route configuration and validates route drift", async () => {
    const { session } = await makeSeededSession("toolguard-bundle-route-config-");
    const registry = new ToolRegistry();
    registry.register({
      toolName: "http.route",
      title: "HTTP route",
      description: "Records deterministic route configuration for bundle hashing.",
      protocol: "http",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      destructiveRisk: "none",
      routeMetadata: {
        routeType: "mcp-adapter",
        routeId: "route-alpha",
        downstreamTargetIdentity: "fixture-http-alpha",
        endpoint: { protocol: "http", host: "127.0.0.1", port: 3662, path: "/tools/http.route" },
        transport: { kind: "streamable-http", url: "http://127.0.0.1:3662/tools/http.route" },
        toolRoute: { virtualToolName: "http.route", originalToolName: "alpha" },
        adapterConfigHash: "adapter-config-alpha"
      },
      execute: () => ({ ok: true })
    });
    await session.executeToolCall(registry, {
      ...makeToolCall(session.runId),
      toolName: "http.route",
      downstreamServerId: registry.get("http.route")?.downstreamServerId ?? createId("server")
    });

    const bundle = await exportEvidenceBundle({ session });
    const reproducibilityPath = path.join(bundle.bundleDir, "reproducibility-checks.json");
    const reproducibility = await readJson<{
      expected: { routeConfigHash: string; recordedRouteConfigs: Array<Record<string, unknown>> };
    }>(reproducibilityPath);
    expect(reproducibility.expected.routeConfigHash).toMatch(/^[a-f0-9]{64}$/);
    expect(reproducibility.expected.recordedRouteConfigs[0]).toMatchObject({
      routeType: "mcp-adapter",
      routeId: "route-alpha",
      downstreamTargetIdentity: "fixture-http-alpha",
      adapterConfigHash: "adapter-config-alpha"
    });

    const { session: changedSession } = await makeSeededSession("toolguard-bundle-route-config-changed-");
    const changedRegistry = new ToolRegistry();
    changedRegistry.register({
      toolName: "http.route",
      title: "HTTP route",
      description: "Records changed route configuration for bundle hashing.",
      protocol: "http",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      destructiveRisk: "none",
      routeMetadata: {
        routeType: "mcp-adapter",
        routeId: "route-alpha",
        downstreamTargetIdentity: "fixture-http-beta",
        endpoint: { protocol: "http", host: "127.0.0.1", port: 3663, path: "/tools/http.route" },
        transport: { kind: "streamable-http", url: "http://127.0.0.1:3663/tools/http.route" },
        toolRoute: { virtualToolName: "http.route", originalToolName: "beta" },
        adapterConfigHash: "adapter-config-beta"
      },
      execute: () => ({ ok: true })
    });
    await changedSession.executeToolCall(changedRegistry, {
      ...makeToolCall(changedSession.runId),
      toolName: "http.route",
      downstreamServerId: changedRegistry.get("http.route")?.downstreamServerId ?? createId("server")
    });
    const changedBundle = await exportEvidenceBundle({ session: changedSession });
    const changedReproducibility = await readJson<{ expected: { routeConfigHash: string } }>(
      path.join(changedBundle.bundleDir, "reproducibility-checks.json")
    );
    expect(changedReproducibility.expected.routeConfigHash).not.toBe(reproducibility.expected.routeConfigHash);

    const drifted = {
      ...reproducibility,
      expected: {
        ...reproducibility.expected,
        recordedRouteConfigs: reproducibility.expected.recordedRouteConfigs.map((config) => ({
          ...config,
          downstreamTargetIdentity: "fixture-http-beta"
        }))
      }
    };
    await writeFile(reproducibilityPath, `${JSON.stringify(drifted, null, 2)}\n`, "utf8");
    await expect(validateEvidenceBundleManifest({ bundleDir: bundle.bundleDir })).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringMatching(/Reproducibility mismatch for routeConfigHash/)])
    });
  });

  it("derives safe loopback only from explicit verified endpoint metadata", async () => {
    const { session: unverifiedSession } = await makeSeededSession("toolguard-bundle-loopback-unverified-");
    const unverifiedRegistry = new ToolRegistry();
    unverifiedRegistry.register({
      toolName: "http.loopback.unverified",
      title: "Unverified loopback",
      description: "Looks like a loopback HTTP side effect but lacks verified endpoint metadata.",
      protocol: "http",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      destructiveRisk: "none",
      routeMetadata: {
        routeType: "direct-http",
        routeId: "unverified-route",
        downstreamTargetIdentity: "unverified-loopback",
        endpoint: { protocol: "http", host: "127.0.0.1", port: 3662, path: "/unverified" }
      },
      execute: () => ({ ok: true })
    });
    await unverifiedSession.executeToolCall(unverifiedRegistry, {
      ...makeToolCall(unverifiedSession.runId),
      toolName: "http.loopback.unverified",
      downstreamServerId: unverifiedRegistry.get("http.loopback.unverified")?.downstreamServerId ?? createId("server")
    });
    const unverifiedBundle = await exportEvidenceBundle({
      session: unverifiedSession,
      replaySafety: { safeLoopback: true }
    });
    expect(unverifiedBundle.manifest.replay.safe).toBe(false);
    expect(unverifiedBundle.manifest.replay.instructionsFile).toBeUndefined();

    const { session: verifiedSession } = await makeSeededSession("toolguard-bundle-loopback-verified-");
    const verifiedRegistry = new ToolRegistry();
    verifiedRegistry.register({
      toolName: "http.loopback.verified",
      title: "Verified loopback",
      description: "Records explicit verified loopback endpoint metadata.",
      protocol: "http",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      destructiveRisk: "none",
      routeMetadata: {
        routeType: "direct-http",
        routeId: "verified-route",
        downstreamTargetIdentity: "verified-loopback",
        endpoint: { protocol: "http", host: "127.0.0.1", port: 3662, path: "/verified" },
        loopbackEndpoint: {
          protocol: "http",
          host: "127.0.0.1",
          port: 3662,
          routeId: "verified-route",
          toolName: "http.loopback.verified",
          verificationStatus: "verified",
          verified: true
        }
      },
      execute: () => ({ ok: true })
    });
    await verifiedSession.executeToolCall(verifiedRegistry, {
      ...makeToolCall(verifiedSession.runId),
      toolName: "http.loopback.verified",
      downstreamServerId: verifiedRegistry.get("http.loopback.verified")?.downstreamServerId ?? createId("server")
    });
    const verifiedBundle = await exportEvidenceBundle({ session: verifiedSession });
    expect(verifiedBundle.manifest.replay.safe).toBe(true);
    expect(verifiedBundle.manifest.replay.reason).toMatch(/safe loopback/i);
    expect(verifiedBundle.manifest.replay.instructionsFile).toBe("replay-instructions.json");
  });

  it("recomputes reproducibility inputs during validation so environment drift is detected", async () => {
    const { session } = await makeSeededSession("toolguard-bundle-repro-drift-");
    const bundle = await exportEvidenceBundle({ session });
    const originalCwd = process.cwd();
    const originalSeed = process.env.TOOLGUARD_FIXTURE_SEED;
    const driftRoot = await mkdtemp(path.join(tmpdir(), "toolguard-bundle-drift-cwd-"));
    await writeFile(path.join(driftRoot, "package.json"), JSON.stringify({ packageManager: "pnpm@99.99.99" }), "utf8");
    try {
      process.env.TOOLGUARD_FIXTURE_SEED = "changed-seed";
      process.chdir(driftRoot);
      const validation = await validateEvidenceBundleManifest({ bundleDir: bundle.bundleDir });
      expect(validation.valid).toBe(false);
      expect(validation.errors).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Reproducibility mismatch for cwd/),
          expect.stringMatching(/Reproducibility mismatch for packageManager/),
          expect.stringMatching(/Reproducibility mismatch for fixtureSeed/)
        ])
      );
    } finally {
      process.chdir(originalCwd);
      if (originalSeed === undefined) {
        delete process.env.TOOLGUARD_FIXTURE_SEED;
      } else {
        process.env.TOOLGUARD_FIXTURE_SEED = originalSeed;
      }
    }
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
    const payload = (await response.json()) as { bundleDir: string; manifestValid: boolean; manifestUrl: string; replayInstructions?: string; replayInstructionsUrl?: string };
    expect(payload.bundleDir).toBe(path.join(session.recorder.runDir, "bundle"));
    expect(payload.manifestValid).toBe(true);
    expect(payload.manifestUrl).toBe(`${baseUrl}/api/bundles/${handle.session.runId}/files/manifest.json`);
    expect(payload.replayInstructions).toBeUndefined();
    expect(payload.replayInstructionsUrl).toBeUndefined();

    const bundleResponse = await fetch(`${baseUrl}/api/bundle`);
    expect(bundleResponse.status).toBe(200);
    const bundlePayload = (await bundleResponse.json()) as {
      bundle: {
        manifestHealth: { label: string };
        artifactHashStatus: { label: string };
        redactionStatus: { label: string };
        replaySafetyStatus: { label: string };
        files: Array<{ url: string; sha256: string; present: boolean; hashed: boolean }>;
      };
    };
    expect(bundlePayload.bundle.manifestHealth.label).toBe("Manifest valid");
    expect(bundlePayload.bundle.artifactHashStatus.label).toMatch(/hashed bundle files/);
    expect(bundlePayload.bundle.redactionStatus.label).toMatch(/redactions recorded/);
    expect(bundlePayload.bundle.replaySafetyStatus.label).toBe("Replay withheld");
    expect(bundlePayload.bundle.files.every((file) => file.url.startsWith(`${baseUrl}/api/bundles/${handle.session.runId}/files/`))).toBe(true);
    expect(bundlePayload.bundle.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: `${baseUrl}/api/bundles/${handle.session.runId}/files/manifest-validation.json`,
          hashed: true,
          present: true,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      ])
    );
    expect(JSON.stringify(bundlePayload)).not.toContain("file://");

    const manifestResponse = await fetch(payload.manifestUrl);
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get("content-type")).toContain("application/json");

    await rm(path.join(session.recorder.runDir, "bundle", "manifest-validation.json"), { force: true });
  });

  it("rejects traversal artifact paths before copying raw bundle evidence", async () => {
    const { root, session } = await makeSeededSession("toolguard-bundle-traversal-");
    const call = makeToolCall(session.runId);
    const outsidePath = path.join(root, "outside-raw.txt");
    await writeFile(outsidePath, "outside content must not be copied\n", "utf8");
    const validArtifact = await session.recordRawArtifact(call, {
      kind: "raw-stdout",
      fileName: "stdout.txt",
      content: "safe content"
    });
    await session.recorder.appendEvent({
      ...session.recorder.events.at(-1)!,
      eventId: createId("event"),
      artifactId: createId("artifact"),
      data: {
        ...validArtifact,
        artifactId: createId("artifact"),
        relativePath: "../outside-raw.txt"
      } satisfies EvidenceArtifact
    });

    await expect(exportEvidenceBundle({ session, replaySafety: { fixtureOnly: true } })).rejects.toThrow(
      /outside the run directory|Invalid artifact relativePath/
    );
  });

  it("rejects absolute artifact paths before copying raw bundle evidence", async () => {
    const { root, session } = await makeSeededSession("toolguard-bundle-absolute-");
    const call = makeToolCall(session.runId);
    const outsidePath = path.join(root, "absolute-raw.txt");
    await writeFile(outsidePath, "absolute content must not be copied\n", "utf8");
    const validArtifact = await session.recordRawArtifact(call, {
      kind: "raw-stderr",
      fileName: "stderr.txt",
      content: "safe content"
    });
    await session.recorder.appendEvent({
      ...session.recorder.events.at(-1)!,
      eventId: createId("event"),
      artifactId: createId("artifact"),
      data: {
        ...validArtifact,
        artifactId: createId("artifact"),
        relativePath: outsidePath
      } satisfies EvidenceArtifact
    });

    await expect(exportEvidenceBundle({ session, replaySafety: { fixtureOnly: true } })).rejects.toThrow(
      /absolute artifact paths|Invalid artifact relativePath/
    );
  });
});
