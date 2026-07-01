import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CoreSession,
  ToolRegistry,
  createCoreApiServer,
  importBrowserEvidence,
  importHttpWebhookEvidence,
  normalizeProviderToolCall,
  wrapLocalToolFunction,
  type CoreApiServerHandle,
  type CoreEvent,
  type JsonObject
} from "../src/index.js";

function originFor(handle: CoreApiServerHandle): string {
  const address = handle.server.address();
  if (typeof address !== "object" || !address) throw new Error("Expected test server address");
  return `http://127.0.0.1:${address.port}`;
}

describe("adapter expansion local visibility routes", () => {
  it("normalizes a JS/TS local function wrapper call into Core events with route limitations", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-js-wrapper-route-"));
    const session = new CoreSession({ evidenceRoot, runId: "run_js_wrapper_route" });
    const wrapped = wrapLocalToolFunction({
      session,
      name: "local.add",
      description: "Adds two local numbers without intercepting native host tools.",
      inputSchema: {
        type: "object",
        required: ["left", "right"],
        properties: { left: { type: "number" }, right: { type: "number" } }
      },
      execute: (args) => ({ sum: Number(args.left) + Number(args.right) }),
      route: {
        routeId: "route_js_ts_local_add",
        harnessId: "harness_js_ts",
        adapterId: "adapter_js_ts_wrapper",
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
      }
    });

    const result = await wrapped({ left: 2, right: 3 });

    expect(result.output).toEqual({ sum: 5 });
    expect(result.safeSummary).toContain("local.add completed");
    const completed = session.recorder.events.find((event) => event.type === "tool.call.completed");
    expect(completed).toMatchObject({
      harnessId: "harness_js_ts",
      adapterId: "adapter_js_ts_wrapper",
      visibility: expect.objectContaining({
        visibilityLevel: "mediated",
        coverageClaim: "mediated",
        routeType: "js-ts-wrapper",
        routeId: "route_js_ts_local_add",
        evidenceScope: "route",
        producingEvidence: true,
        traceContext: expect.objectContaining({ source: "provided" })
      })
    });
    expect(result.limitations).toEqual(expect.arrayContaining([expect.stringMatching(/explicit calls/i)]));
  });

  it("normalizes provider tool-call examples into explicit local wrapper route inputs", () => {
    const normalized = normalizeProviderToolCall({
      provider: "openai",
      payload: {
        id: "call_provider_example",
        function: {
          name: "local.search",
          arguments: JSON.stringify({ query: "ToolGuard", apiKey: `sk-${"A".repeat(48)}` })
        }
      }
    });

    expect(normalized).toMatchObject({
      provider: "openai",
      normalized: {
        originalToolCallId: "call_provider_example",
        toolName: "local.search",
        routeType: "js-ts-wrapper",
        visibilityLevel: "mediated"
      },
      limitations: expect.arrayContaining([expect.stringMatching(/not native provider interception/i)])
    });
    expect(JSON.stringify(normalized.normalized.arguments)).not.toContain("A".repeat(48));
    expect(normalized.normalized.arguments.apiKey).toBe("[REDACTED:sensitive-key]");
  });

  it("imports bounded HTTP/webhook evidence as redacted imported visibility evidence", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-http-import-route-"));
    const session = new CoreSession({ evidenceRoot, runId: "run_http_import_route" });

    const imported = await importHttpWebhookEvidence(session, {
      source: "local-webhook",
      method: "POST",
      path: "/webhook/tool",
      headers: {
        authorization: `Bearer ${"A".repeat(36)}`,
        "content-type": "application/json"
      },
      body: { message: "safe", apiKey: `sk-${"B".repeat(48)}` },
      traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01"
    });

    expect(imported.visibility.visibilityLevel).toBe("imported");
    expect(imported.visibility.routeType).toBe("http-webhook-import");
    expect(imported.visibility.traceContext.source).toBe("provided");
    expect(imported.safeSummary).not.toContain("A".repeat(36));
    expect(imported.safeSummary).not.toContain("B".repeat(48));
    expect(JSON.stringify(imported.safeEvidence)).not.toContain("A".repeat(36));
    expect(JSON.stringify(imported.safeEvidence)).not.toContain("B".repeat(48));

    const persisted = await readFile(session.recorder.eventsPath, "utf8");
    expect(persisted).toContain("\"visibilityLevel\":\"imported\"");
    expect(persisted).toContain("\"routeType\":\"http-webhook-import\"");
    expect(persisted).not.toContain("A".repeat(36));
    expect(persisted).not.toContain("B".repeat(48));
  });

  it("exposes an HTTP import API that produces redacted observed/imported route evidence", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-http-import-api-"));
    const handle = createCoreApiServer({ port: 0, evidenceRoot, seedDirectRun: false });
    await handle.ready;
    try {
      const response = await fetch(`${originFor(handle)}/api/visibility/import/http`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "curl-local",
          method: "POST",
          path: "/fixture",
          headers: { authorization: `Bearer ${"C".repeat(36)}` },
          body: { token: `sk-${"D".repeat(48)}` }
        })
      });
      const payload = (await response.json()) as { visibility: { visibilityLevel: string; routeType: string }; safeSummary: string };

      expect(response.status).toBe(202);
      expect(payload.visibility).toMatchObject({ visibilityLevel: "imported", routeType: "http-webhook-import" });
      expect(payload.safeSummary).not.toContain("C".repeat(36));
      expect(JSON.stringify(handle.session.recorder.events)).not.toContain("D".repeat(48));

      const integrationsResponse = await fetch(`${originFor(handle)}/api/integrations`);
      const integrationsPayload = (await integrationsResponse.json()) as {
        routeCoverage: Array<{
          routeType: string;
          claim: string;
          configured: boolean;
          available: boolean;
          producingEvidence: boolean;
          evidenceFreshness: string;
          checks: Array<{ label: string; state: string; evidence: string }>;
        }>;
      };
      const httpImportRow = integrationsPayload.routeCoverage.find((row) => row.routeType === "http-webhook-import");
      expect(httpImportRow).toMatchObject({
        claim: "imported",
        configured: true,
        available: true,
        producingEvidence: true,
        evidenceFreshness: "recent",
        checks: [expect.objectContaining({ label: "Adapter visibility output", state: "producing-evidence" })]
      });
    } finally {
      await handle.close();
    }
  });

  it("derives integrations route coverage from wrapper, HTTP import, and browser import visibility events", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-route-coverage-events-"));
    const session = new CoreSession({ evidenceRoot, runId: "run_route_coverage_events" });
    const handle = createCoreApiServer({ port: 0, evidenceRoot, session, seedDirectRun: false });
    await handle.ready;
    try {
      const wrapped = wrapLocalToolFunction({
        session,
        name: "local.visible",
        execute: () => ({ ok: true })
      });
      await wrapped({});
      await importHttpWebhookEvidence(session, {
        source: "direct-helper",
        body: { ok: true, apiKey: `sk-${"H".repeat(48)}` }
      });
      await importBrowserEvidence(session, {
        pageUrl: "http://127.0.0.1:3661/demo?token=secretsecretsecretsecret",
        console: [{ level: "info", message: "visible browser evidence", count: 1 }]
      });

      const response = await fetch(`${originFor(handle)}/api/integrations`);
      const payload = (await response.json()) as {
        routeCoverage: Array<{
          routeType: string;
          configured: boolean;
          available: boolean;
          producingEvidence: boolean;
          evidenceFreshness: string;
        }>;
      };
      for (const routeType of ["js-ts-wrapper", "http-webhook-import", "browser-evidence-import"]) {
        expect(payload.routeCoverage.find((row) => row.routeType === routeType)).toMatchObject({
          configured: true,
          available: true,
          producingEvidence: true,
          evidenceFreshness: "recent"
        });
      }
      expect(JSON.stringify(payload)).not.toContain("H".repeat(48));
      expect(JSON.stringify(payload)).not.toContain("secretsecretsecretsecret");
    } finally {
      await handle.close();
    }
  });

  it("keeps direct HTTP import helper output bounded, truncated, and free of raw secrets", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-http-import-bounds-"));
    const session = new CoreSession({ evidenceRoot, runId: "run_http_import_bounds" });
    const rawSecret = `sk-${"S".repeat(60)}`;
    const bearerSecret = `Bearer ${"T".repeat(48)}`;
    const oversized = `${rawSecret}-${"x".repeat(40_000)}`;
    const deepPayload: JsonObject = makeDeepPayload(0, rawSecret);

    const imported = await importHttpWebhookEvidence(session, {
      source: "direct-helper",
      method: "POST",
      path: "/oversized",
      headers: {
        authorization: bearerSecret,
        "x-many-values": Array.from({ length: 100 }, (_, index) => `value-${index}`).join(",")
      },
      body: {
        oversized,
        deepPayload,
        many: Array.from({ length: 300 }, (_, index) => ({ index, token: rawSecret }))
      }
    });

    const safeEvidenceText = JSON.stringify(imported.safeEvidence);
    expect(safeEvidenceText.length).toBeLessThan(20_000);
    expect(safeEvidenceText).toContain("[TRUNCATED:");
    expect(imported.safeEvidence.redaction).toEqual(
      expect.objectContaining({ reasons: expect.arrayContaining(["sensitive-key"]) })
    );
    expect(safeEvidenceText).not.toContain(rawSecret);
    expect(safeEvidenceText).not.toContain("S".repeat(60));
    expect(safeEvidenceText).not.toContain("T".repeat(48));
    expect(imported.safeSummary).not.toContain(rawSecret);

    const persisted = await readFile(session.recorder.eventsPath, "utf8");
    expect(persisted).toContain("[TRUNCATED:");
    expect(persisted).not.toContain(rawSecret);
    expect(persisted).not.toContain("x".repeat(1_000));
  });

  it("imports browser screenshot, console, and network summaries without secrets by default", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-browser-evidence-route-"));
    const session = new CoreSession({ evidenceRoot, runId: "run_browser_evidence_route" });

    const imported = await importBrowserEvidence(session, {
      pageUrl: "http://127.0.0.1:3661/harness-integrations?token=abc123secret456789012345",
      screenshot: {
        label: "Harness Integrations route table",
        mimeType: "image/png",
        byteLength: 128_000,
        sha256: "f".repeat(64)
      },
      console: [
        { level: "error", message: `failed with api_key=${"E".repeat(32)}`, count: 1 },
        { level: "warning", message: "unsupported native route shown", count: 2 }
      ],
      network: [
        { method: "GET", url: "http://127.0.0.1:3660/api/integrations?authorization=Bearer secretsecretsecretsecret", status: 200 }
      ],
      traceparent: "00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01"
    });

    expect(imported.visibility).toMatchObject({
      visibilityLevel: "observed",
      coverageClaim: "observed",
      routeType: "browser-evidence-import",
      producingEvidence: true
    });
    expect(imported.safeEvidence.console).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("[REDACTED") })])
    );
    expect(JSON.stringify(imported.safeEvidence)).not.toContain("E".repeat(32));
    expect(JSON.stringify(imported.safeEvidence)).not.toContain("secretsecretsecretsecret");
    expect(session.recorder.events.map((event: CoreEvent) => event.type)).toEqual(
      expect.arrayContaining(["visibility.imported", "evidence.artifact.created"])
    );
    expect(imported.limitations).toEqual(expect.arrayContaining([expect.stringMatching(/did not mediate/i)]));
  });

  it("keeps Python sidecar route metadata and provided trace context in Core receipts", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "toolguard-python-route-metadata-"));
    const registry = new ToolRegistry();
    registry.register({
      toolName: "fixture.adapter-expansion",
      title: "Adapter expansion fixture",
      description: "Safe local fixture",
      protocol: "fixture",
      downstreamServerId: "server_adapter_expansion",
      inputSchema: { type: "object" },
      destructiveRisk: "none",
      execute: () => ({ ok: true })
    });
    const session = new CoreSession({ evidenceRoot, runId: "run_python_route_metadata" });
    const handle = createCoreApiServer({ port: 0, evidenceRoot, session, registry, seedDirectRun: false });
    await handle.ready;
    try {
      const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
      const response = await fetch(`${originFor(handle)}/api/sidecar/v1/tool-calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: "toolguard.sidecar.v1",
          toolName: "fixture.adapter-expansion",
          arguments: {},
          harnessId: "harness_python_route",
          adapterId: "adapter_python_route",
          correlation: {
            runId: "run_python_route_metadata",
            traceId: "trace_python_route",
            toolCallId: "toolcall_python_route",
            attemptId: "attempt_python_route",
            policyDecisionId: "policy_python_route"
          },
          routeMetadata: {
            routeId: "route_python_langgraph",
            routeType: "sdk-wrapped-python",
            traceContext: { traceparent },
            platform: { hostId: "python-framework-adapters", transport: "http-loopback-sidecar" },
            coverage: { claim: "observed", evidenceScope: "route", producingEvidence: true }
          }
        })
      });

      expect(response.status).toBe(200);
      const completed = session.recorder.events.find((event) => event.type === "tool.call.completed");
      expect(completed).toMatchObject({
        runId: "run_python_route_metadata",
        traceId: "trace_python_route",
        harnessId: "harness_python_route",
        adapterId: "adapter_python_route",
        toolCallId: "toolcall_python_route",
        visibility: expect.objectContaining({
          visibilityLevel: "observed",
          routeType: "sdk-wrapped-python",
          routeId: "route_python_langgraph",
          producingEvidence: true,
          traceContext: { traceparent, source: "provided" }
        })
      });
    } finally {
      await handle.close();
    }
  });
});

function makeDeepPayload(level: number, rawSecret: string): JsonObject {
  if (level >= 20) return { level, secret: rawSecret };
  return { level, secret: "safe", child: makeDeepPayload(level + 1, rawSecret) };
}
