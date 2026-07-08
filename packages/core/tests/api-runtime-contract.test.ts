import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoreSession,
  ToolRegistry,
  createCoreApiServer,
  createId,
  registerChaosFixtures,
  verifyIntegrationRoute,
  type CoreApiServerHandle,
  type StableId,
  type ToolCall
} from "../src/index.js";

const handles: CoreApiServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("Core API runtime contract", () => {
  it("runs on ephemeral loopback port 0 and exposes stable JSON and non-JSON content types", async () => {
    const { handle, baseUrl } = await startCoreApi("toolguard-api-content-types-");
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(baseUrl).not.toMatch(/:(366[0-9])$/);

    for (const route of ["/health", "/api/runs/latest", "/api/run-index", "/api/integrations", "/api/replay"]) {
      const response = await fetch(`${baseUrl}${route}`);
      expect(response.status, route).toBe(200);
      expect(response.headers.get("content-type"), route).toContain("application/json");
      expect(await response.json(), route).toEqual(expect.any(Object));
    }

    const reportResponse = await fetch(`${baseUrl}/api/reports/export`);
    expect(reportResponse.status).toBe(200);
    expect(reportResponse.headers.get("content-type")).toContain("application/json");
    const report = (await reportResponse.json()) as {
      reportUrl: string;
      manifestUrl: string;
      artifactHashUrl: string;
      redactionSummaryUrl: string;
      manifestValid: boolean;
    };
    expect(report.manifestValid).toBe(true);

    const bundleResponse = await fetch(`${baseUrl}/api/bundle/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replaySafety: { fixtureOnly: true } })
    });
    expect(bundleResponse.status).toBe(200);
    expect(bundleResponse.headers.get("content-type")).toContain("application/json");
    const bundle = (await bundleResponse.json()) as {
      manifestUrl: string;
      manifestValidationUrl: string;
      manifestValid: boolean;
      files: Record<string, string>;
    };
    expect(bundle.manifestValid).toBe(true);
    expect(Object.keys(bundle.files).length).toBeGreaterThan(0);

    await expectContentType(report.reportUrl, "text/html");
    await expectContentType(report.manifestUrl, "application/json");
    await expectContentType(report.artifactHashUrl, "application/json");
    await expectContentType(report.redactionSummaryUrl, "application/json");
    await expectContentType(bundle.manifestUrl, "application/json");
    await expectContentType(bundle.manifestValidationUrl, "application/json");

    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    expect(await metrics.text()).toContain("toolguard_events_total");

    const issuePacket = await fetch(`${baseUrl}/api/triage/issue-packet`);
    expect(issuePacket.status).toBe(200);
    expect(issuePacket.headers.get("content-type")).toContain("text/markdown");
    expect(await issuePacket.text()).toContain("ToolGuard issue packet");

    const events = await fetch(`${baseUrl}/events`);
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    await events.body?.cancel();

    expect(handle.server.listening).toBe(true);
  });

  it("returns documented JSON errors for unsupported methods, bad routes, malformed JSON, and body limits", async () => {
    const { baseUrl } = await startCoreApi("toolguard-api-errors-");

    const methodMismatch = await fetch(`${baseUrl}/api/integrations`, { method: "POST" });
    expect(methodMismatch.status).toBe(405);
    expect(methodMismatch.headers.get("content-type")).toContain("application/json");
    await expect(methodMismatch.json()).resolves.toMatchObject({
      error: "method_not_allowed",
      allowedMethods: ["GET"]
    });

    const unknownRoute = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(unknownRoute.status).toBe(404);
    expect(unknownRoute.headers.get("content-type")).toContain("application/json");
    await expect(unknownRoute.json()).resolves.toMatchObject({ error: "not_found" });

    const malformed = await fetch(`${baseUrl}/api/visibility/import/http`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toContain("application/json");
    await expect(malformed.json()).resolves.toMatchObject({ error: expect.stringMatching(/malformed JSON/) });

    const oversized = await fetch(`${baseUrl}/api/visibility/import/browser`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ console: [{ message: "x".repeat(256 * 1024 + 1) }] })
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("content-type")).toContain("application/json");
    await expect(oversized.json()).resolves.toMatchObject({ error: expect.stringMatching(/byte limit/) });

    const blockedReplay = await fetch(`${baseUrl}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        toolName: "real-world.rm-rf",
        sourceRunId: "run_safe",
        fixtureOnly: false,
        mode: "real-world",
        destructive: true
      })
    });
    expect(blockedReplay.status).toBe(409);
    await expect(blockedReplay.json()).resolves.toMatchObject({
      status: "blocked",
      safe: false
    });
  });

  it("keeps verification, integration inventory, visibility imports, and JSON request content-type contracts API-consumable", async () => {
    const { handle, baseUrl } = await startCoreApi("toolguard-api-integrations-");

    const verificationResponse = await fetch(`${baseUrl}/api/integrations/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeType: "js-ts-wrapper" })
    });
    expect(verificationResponse.status).toBe(200);
    const verification = (await verificationResponse.json()) as {
      receiptId: string;
      runId: string;
      timestamp: string;
      routeType: string;
      checkedCapabilities: unknown[];
      routeCoverage: unknown[];
      limitations: string[];
      evidenceLinks: Array<{ routeType: string; evidenceScope: string }>;
      platformPassport?: { passportId: string };
    };
    expect(verification).toMatchObject({
      receiptId: expect.stringMatching(/^receipt_/),
      runId: handle.session.runId,
      routeType: "js-ts-wrapper",
      checkedCapabilities: expect.any(Array),
      routeCoverage: expect.any(Array),
      limitations: expect.arrayContaining([expect.stringMatching(/wrapper/i)]),
      evidenceLinks: expect.arrayContaining([expect.objectContaining({ routeType: "js-ts-wrapper", evidenceScope: "route" })])
    });
    expect(verification.timestamp).toMatch(/T/);
    expect(verification.platformPassport?.passportId).toContain("js_ts_wrapper");

    const unknownVerification = await fetch(`${baseUrl}/api/integrations/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeType: "unknown-route" })
    });
    expect(unknownVerification.status).toBe(400);
    await expect(unknownVerification.json()).resolves.toMatchObject({ error: "unknown_integration_route_type" });

    const missingContentType = await fetch(`${baseUrl}/api/policy/simulate`, {
      method: "POST",
      body: JSON.stringify({ scenarioId: "blocked-destructive", proposedPolicy: { destructiveAction: "block" } })
    });
    expect(missingContentType.status).toBe(200);
    await expect(missingContentType.json()).resolves.toMatchObject({ scenarioId: "blocked-destructive" });

    const wrongContentType = await fetch(`${baseUrl}/api/story/reset`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ scenarioId: "raw-failure" })
    });
    expect(wrongContentType.status).toBe(200);
    await expect(wrongContentType.json()).resolves.toMatchObject({ scenarioId: "raw-failure" });

    const importedToken = "I".repeat(36);
    const importedApiKey = "J".repeat(36);
    const httpImportResponse = await fetch(`${baseUrl}/api/visibility/import/http`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "contract-test-webhook",
        method: "POST",
        path: "/webhook",
        headers: { authorization: ["Bearer", importedToken].join(" ") },
        body: { safe: true, [["api", "key"].join("_")]: importedApiKey },
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
      })
    });
    expect(httpImportResponse.status).toBe(202);
    const httpImport = (await httpImportResponse.json()) as {
      event: { visibility?: { routeType?: string; visibilityLevel?: string; evidenceScope?: string } };
      artifactId: string;
      safeEvidence: unknown;
    };
    expect(httpImport).toMatchObject({
      event: {
        visibility: {
          routeType: "http-webhook-import",
          visibilityLevel: "imported",
          evidenceScope: "route"
        }
      },
      artifactId: expect.stringMatching(/^artifact_/)
    });
    expect(JSON.stringify(httpImport)).not.toContain(importedToken);
    expect(JSON.stringify(httpImport)).not.toContain(importedApiKey);
    expect(JSON.stringify(httpImport)).toContain("[REDACTED:");

    const browserMarker = "K".repeat(36);
    const browserApiKey = "L".repeat(36);
    const browserImportResponse = await fetch(`${baseUrl}/api/visibility/import/browser`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageUrl: `http://127.0.0.1:3661/path?token=${browserMarker}`,
        screenshot: { label: "synthetic proof", mimeType: "image/png", byteLength: 512, sha256: "a".repeat(64) },
        console: [{ level: "warn", message: `${["api", "key"].join("_")}=${browserApiKey}`, count: 1 }],
        network: [
          {
            method: "GET",
            url: `http://127.0.0.1:3660/api/integrations?authorization=${encodeURIComponent(["Bearer", browserMarker].join(" "))}`,
            status: 200
          }
        ]
      })
    });
    expect(browserImportResponse.status).toBe(202);
    const browserImport = (await browserImportResponse.json()) as {
      event: { visibility?: { routeType?: string; visibilityLevel?: string } };
      safeEvidence: unknown;
    };
    expect(browserImport).toMatchObject({
      event: { visibility: { routeType: "browser-evidence-import", visibilityLevel: "observed" } }
    });
    expect(JSON.stringify(browserImport)).not.toContain(browserMarker);
    expect(JSON.stringify(browserImport)).not.toContain(browserApiKey);

    const integrationsResponse = await fetch(`${baseUrl}/api/integrations`);
    expect(integrationsResponse.status).toBe(200);
    const integrations = (await integrationsResponse.json()) as {
      routeInventory: Array<{ id: string; visibilityLevel: string; coverageClaim: string; limitations: string[] }>;
      routeCoverage: Array<{
        routeType: string;
        claim: string;
        configured: boolean;
        available: boolean;
        producingEvidence: boolean;
        checkedCapabilities: unknown[];
        evidenceLinks: unknown[];
      }>;
      integrations: Array<{ id: string; claimLevel: string; status: string; limitation: string }>;
      setupMetadata: { snippets: Array<{ route: string; canonicalInventoryId: string }> };
    };
    expect(integrations.routeInventory.find((entry) => entry.id === "browser-evidence-import")).toMatchObject({
      visibilityLevel: "observed",
      coverageClaim: "observed",
      limitations: expect.arrayContaining([expect.stringMatching(/does not launch a browser/i)])
    });
    expect(integrations.routeCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeType: "js-ts-wrapper",
          claim: "mediated",
          configured: true,
          available: true,
          producingEvidence: true,
          proofSurfaces: expect.arrayContaining(["wrapLocalToolFunction"])
        }),
        expect.objectContaining({
          routeType: "http-webhook-import",
          claim: "imported",
          producingEvidence: true
        }),
        expect.objectContaining({
          routeType: "browser-evidence-import",
          claim: "observed",
          producingEvidence: true
        })
      ])
    );
    expect(integrations.integrations.find((entry) => entry.id === "direct-core-api")).toMatchObject({
      status: "available",
      limitation: expect.stringMatching(/loopback Core API/)
    });
    expect(integrations.setupMetadata.snippets).toEqual(
      expect.arrayContaining([expect.objectContaining({ route: "shell-api", canonicalInventoryId: "direct-core-api" })])
    );
  });

  it("exposes report and bundle proof payloads with constrained file serving and route correlation", async () => {
    const { handle, baseUrl } = await startCoreApi("toolguard-api-proof-payloads-", true);
    const runId = handle.session.runId;
    const receipt = await verifyIntegrationRoute({
      session: handle.session,
      routeType: "js-ts-wrapper",
      workspaceRoot: path.resolve("../..")
    });

    const reportExport = await fetchJson<{
      manifestValid: boolean;
      validationErrors: string[];
      reportUrl: string;
      manifestUrl: string;
      artifactHashUrl: string;
      redactionSummaryUrl: string;
    }>(`${baseUrl}/api/reports/export`);
    expect(reportExport).toMatchObject({
      manifestValid: true,
      validationErrors: [],
      reportUrl: `${baseUrl}/api/reports/${runId}/files/report.html`
    });

    const reportList = await fetchJson<{
      reports: Array<{
        runId: string;
        reportUrl: string;
        manifestUrl: string;
        artifactHashUrl: string;
        redactionSummaryUrl: string;
        manifestValid: boolean;
        artifacts: Array<{ artifactId: string; artifactUrl: string }>;
      }>;
    }>(`${baseUrl}/api/reports`);
    const report = reportList.reports[0]!;
    expect(report).toMatchObject({
      runId,
      manifestValid: true,
      reportUrl: `${baseUrl}/api/reports/${runId}/files/report.html`,
      manifestUrl: `${baseUrl}/api/reports/${runId}/files/manifest.json`,
      artifactHashUrl: `${baseUrl}/api/reports/${runId}/files/artifact-hashes.json`,
      redactionSummaryUrl: `${baseUrl}/api/reports/${runId}/files/redaction-summary.json`
    });
    expect(report.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ artifactUrl: expect.stringContaining(`/api/reports/${runId}/artifacts/`) })])
    );

    const bundleExport = await fetchJson<{
      manifestValid: boolean;
      validationErrors: string[];
      manifestUrl: string;
      manifestValidationUrl: string;
      files: Record<string, string>;
    }>(`${baseUrl}/api/bundle/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replaySafety: { fixtureOnly: true } })
    });
    expect(bundleExport).toMatchObject({
      manifestValid: true,
      validationErrors: [],
      manifestUrl: `${baseUrl}/api/bundles/${runId}/files/manifest.json`,
      manifestValidationUrl: `${baseUrl}/api/bundles/${runId}/files/manifest-validation.json`
    });
    expect(Object.values(bundleExport.files)).toContain("visibility-metadata.json");

    const bundleSummary = await fetchJson<{
      bundle: {
        manifestValid: boolean;
        files: Array<{ relativePath: string; url: string; sha256: string; present: boolean; hashed: boolean }>;
        artifactHashes: Array<{ relativePath: string; sha256: string }>;
        rawArtifacts: Array<{ url: string; relativePath: string }>;
        trust: { containedLinksOnly: boolean; safeFieldsExcludeRawOutput: boolean };
      };
    }>(`${baseUrl}/api/bundle`);
    expect(bundleSummary.bundle.manifestValid).toBe(true);
    expect(bundleSummary.bundle.trust).toMatchObject({ containedLinksOnly: true, safeFieldsExcludeRawOutput: true });
    expect(bundleSummary.bundle.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "integration-verification-receipts.json",
          url: `${baseUrl}/api/bundles/${runId}/files/integration-verification-receipts.json`,
          present: true,
          hashed: true,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      ])
    );

    const manifest = await fetchJson<{
      runId: string;
      visibility: {
        coverageReceipts: Array<{ receiptId: string; routeType: string; runId: string }>;
        routePassports: Array<{ passportId: string; routeType: string }>;
      };
    }>(bundleExport.manifestUrl);
    expect(manifest.runId).toBe(runId);
    expect(manifest.visibility.coverageReceipts).toEqual(
      expect.arrayContaining([expect.objectContaining({ receiptId: receipt.receiptId, routeType: "js-ts-wrapper", runId })])
    );
    expect(manifest.visibility.routePassports).toEqual(
      expect.arrayContaining([expect.objectContaining({ passportId: receipt.platformPassport?.passportId, routeType: "js-ts-wrapper" })])
    );

    const receiptFile = await fetchJson<{
      receipts: Array<{ receiptId: string; runId: string; routeType: string; evidenceLinks: Array<{ routeType: string }> }>;
    }>(`${baseUrl}/api/bundles/${runId}/files/integration-verification-receipts.json`);
    expect(receiptFile.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          receiptId: receipt.receiptId,
          runId,
          routeType: "js-ts-wrapper",
          evidenceLinks: expect.arrayContaining([expect.objectContaining({ routeType: "js-ts-wrapper" })])
        })
      ])
    );

    const reportHtml = await fetch(report.reportUrl);
    expect(reportHtml.status).toBe(200);
    expect(reportHtml.headers.get("cache-control")).toBe("no-store");
    expect(reportHtml.headers.get("x-content-type-options")).toBe("nosniff");

    for (const unsafeUrl of [
      `${baseUrl}/api/reports/${runId}/files/../events.jsonl`,
      `${baseUrl}/api/reports/run_wrong/files/report.html`,
      `${baseUrl}/api/reports/${runId}/files/missing.html`,
      `${baseUrl}/api/bundles/${runId}/files/../events.jsonl`,
      `${baseUrl}/api/bundles/run_wrong/files/manifest.json`,
      `${baseUrl}/api/bundles/${runId}/files/missing.json`
    ]) {
      const response = await fetch(unsafeUrl);
      expect(response.status, unsafeUrl).toBeGreaterThanOrEqual(403);
      expect(response.headers.get("content-type"), unsafeUrl).toContain("application/json");
      const body = await response.text();
      const unsafePattern = new RegExp(
        ["Bearer\\s+", ["BEGIN", "PRIVATE", "KEY"].join(" "), "api[_-]?key=", "secret[a-z0-9]{8,}"].join("|"),
        "i"
      );
      expect(body, unsafeUrl).not.toMatch(unsafePattern);
    }
  });

  it("keeps OpenAPI method, error, dynamic template, content-type, and UI model contracts aligned with runtime", async () => {
    const openApi = await readProjectFile("docs/api/openapi.yaml");
    const paths = parseOpenApiPaths(openApi);

    expect(paths.get("/api/integrations")).toMatchObject({
      methods: ["get"],
      contentTypes: ["application/json"],
      responses: expect.arrayContaining(["200", "405"])
    });
    expect(paths.get("/api/integrations/verify")).toMatchObject({
      methods: ["post"],
      contentTypes: ["application/json"],
      responses: expect.arrayContaining(["200", "400", "405"])
    });
    expect(paths.get("/api/visibility/import/http")).toMatchObject({
      methods: ["post"],
      contentTypes: ["application/json"],
      responses: expect.arrayContaining(["202", "400", "405", "413"])
    });
    expect(paths.get("/api/visibility/import/browser")).toMatchObject({
      methods: ["post"],
      contentTypes: ["application/json"],
      responses: expect.arrayContaining(["202", "400", "405", "413"])
    });
    expect(paths.get("/api/events/ingest")).toMatchObject({
      methods: ["post"],
      responses: expect.arrayContaining(["202", "400", "405", "413"])
    });
    expect(paths.get("/api/sidecar/v1/tool-calls")).toMatchObject({
      methods: ["post"],
      responses: expect.arrayContaining(["200", "400", "405", "413", "426"])
    });
    expect(paths.get("/metrics")?.contentTypes).toContain("text/plain");
    expect(paths.get("/events")?.contentTypes).toContain("text/event-stream");
    expect(paths.get("/api/triage/issue-packet")?.contentTypes).toContain("text/markdown");

    expect([...paths.keys()]).toEqual(
      expect.arrayContaining([
        "/api/reports/{runId}/files/{fileName}",
        "/api/reports/{runId}/artifacts/{artifactId}",
        "/api/bundles/{runId}/files/{relativePath}",
        "/api/runs/{runId}/evidence"
      ])
    );
    expect(openApi).toContain("Slash-delimited bundle-relative path constrained to the active bundle directory.");
    expect(openApi).toContain("Concrete run ID or the alias latest where supported.");
    expect(openApi).toContain("enum: [report.html, manifest.json, artifact-hashes.json, redaction-summary.json]");

    for (const schemaName of [
      "LatestRunPayload",
      "RunIndexPayload",
      "HealthPayload",
      "FailureInboxPayload",
      "ImpactPayload",
      "TriagePayload",
      "TracePayload",
      "PolicyPayload",
      "ReplayPayload",
      "ReportsPayload",
      "ReportExportResponse",
      "BundlePayload",
      "BundleExportResponse",
      "ValidationDashboardPayload",
      "TopologyPayload",
      "NarrativePayload",
      "IntegrationsPayload",
      "IntegrationVerificationReceipt"
    ]) {
      expect(openApi, schemaName).toMatch(new RegExp(`^    ${schemaName}:`, "m"));
    }

    for (const requiredField of [
      "eventCount",
      "records",
      "summary",
      "rows",
      "failures",
      "entries",
      "replayCategories",
      "fixtures",
      "reports",
      "manifestValid",
      "validationErrors",
      "routeCoverage",
      "coverageHistory",
      "artifactCoverage",
      "checks",
      "freshCorrelation",
      "redactionSummary",
      "bundle",
      "manifestValidationUrl"
    ]) {
      expect(openApi, requiredField).toContain(`${requiredField}:`);
    }
  });
});

async function startCoreApi(prefix: string, seedDirectRun = false): Promise<{ handle: CoreApiServerHandle; baseUrl: string }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const session = new CoreSession({ evidenceRoot: root, runId: createId("run") });
  const registry = new ToolRegistry();
  registerChaosFixtures(registry, { sandboxRoot: root });
  await session.executeToolCall(
    registry,
    makeToolCall(session.runId, registry.get("fixture.echo")?.downstreamServerId ?? createId("server"))
  );
  const handle = createCoreApiServer({
    host: "127.0.0.1",
    port: 0,
    evidenceRoot: root,
    session,
    registry,
    seedDirectRun
  });
  handles.push(handle);
  await handle.ready;
  return { handle, baseUrl: originFor(handle) };
}

function originFor(handle: CoreApiServerHandle): string {
  const address = handle.server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("Expected Core API test server to have an address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function makeToolCall(runId: StableId, downstreamServerId: StableId): ToolCall {
  return {
    runId,
    traceId: createId("trace"),
    parentId: createId("parent"),
    harnessId: createId("harness"),
    adapterId: createId("adapter"),
    downstreamServerId,
    toolCallId: createId("toolcall"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName: "fixture.echo",
    arguments: { message: "contract-test" },
    deadlineMs: 1_000,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    routeMetadata: {
      routeType: "direct-core-api",
      routeId: "direct-core-api",
      downstreamTargetIdentity: "CoreSession",
      transport: { kind: "in-process-core" },
      coverage: { claim: "mediated", evidenceScope: "route", producingEvidence: true }
    }
  };
}

async function expectContentType(url: string, expected: string): Promise<void> {
  const response = await fetch(url);
  expect(response.status, url).toBe(200);
  expect(response.headers.get("content-type"), url).toContain(expected);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.ok, `${init?.method ?? "GET"} ${url} returned ${response.status}`).toBe(true);
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as T;
}

async function readProjectFile(relativePath: string): Promise<string> {
  return await readFile(path.join(process.cwd(), "../..", relativePath), "utf8");
}

interface OpenApiPathInfo {
  readonly methods: string[];
  readonly responses: string[];
  readonly contentTypes: string[];
}

function parseOpenApiPaths(source: string): Map<string, OpenApiPathInfo> {
  const paths = new Map<string, { methods: Set<string>; responses: Set<string>; contentTypes: Set<string> }>();
  const lines = source.split("\n");
  let inPaths = false;
  let currentPath: string | undefined;
  let currentMethod: string | undefined;
  let inResponses = false;
  let inContent = false;

  for (const line of lines) {
    if (line === "paths:") {
      inPaths = true;
      continue;
    }
    if (inPaths && /^[a-z]/.test(line) && line !== "paths:") {
      break;
    }
    const pathMatch = /^ {2}(\/[^:]+):$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1] ?? "";
      currentMethod = undefined;
      inResponses = false;
      inContent = false;
      paths.set(currentPath, { methods: new Set(), responses: new Set(), contentTypes: new Set() });
      continue;
    }
    const methodMatch = /^ {4}(get|post|put):$/.exec(line);
    if (currentPath && methodMatch) {
      currentMethod = methodMatch[1] ?? "";
      paths.get(currentPath)?.methods.add(currentMethod);
      inResponses = false;
      inContent = false;
      continue;
    }
    if (!currentPath || !currentMethod) continue;
    if (/^ {6}responses:$/.test(line)) {
      inResponses = true;
      inContent = false;
      continue;
    }
    if (/^ {10}content:$/.test(line)) {
      inContent = true;
      continue;
    }
    if (/^ {8}\$ref: "#\/components\/requestBodies\/JsonObject"$/.test(line)) {
      paths.get(currentPath)?.contentTypes.add("application/json");
      continue;
    }
    if (inResponses) {
      const responseMatch = /^ {8}"?([0-9]{3})"?\s*:/.exec(line);
      if (responseMatch) {
        paths.get(currentPath)?.responses.add(responseMatch[1] ?? "");
      }
    }
    if (inContent) {
      const contentMatch = /^ {12}([a-z]+\/[^:]+):$/.exec(line);
      if (contentMatch) {
        paths.get(currentPath)?.contentTypes.add(contentMatch[1] ?? "");
      }
    }
  }

  return new Map(
    [...paths.entries()].map(([routePath, info]) => [
      routePath,
      {
        methods: [...info.methods].sort(),
        responses: [...info.responses].sort(),
        contentTypes: [...info.contentTypes].sort()
      }
    ])
  );
}
