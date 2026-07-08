import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_VISIBILITY_SCHEMA_VERSION,
  CoreSession,
  createCoreApiServer,
  createId,
  exportVisibilityOtel,
  importVisibilityEventsJsonl,
  type CoreEvent,
  type ToolCall
} from "../src/index.js";

function makeToolCall(runId = createId("run")): ToolCall {
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
    arguments: { message: "safe" },
    idempotency: "idempotent",
    sourcePath: "cli-wrapper",
    routeMetadata: {
      routeType: "cli-supervised",
      coverage: { claim: "supervised", evidenceScope: "route", producingEvidence: true }
    }
  };
}

describe("visibility interoperability import/export", () => {
  it("exports local OpenTelemetry-compatible spans without credentials or secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-otel-export-"));
    const call = makeToolCall();
    const session = new CoreSession({ evidenceRoot: root, runId: call.runId });

    await session.mediateSuccessfulCall(call, { ok: true, token: `Bearer ${"A".repeat(32)}` });
    await session.failToolCall({ ...makeToolCall(call.runId), toolName: "fixture.fail", traceId: call.traceId }, "non_zero_exit", [
      `failure with sk-${"B".repeat(48)}`
    ]);

    const outputPath = path.join(session.recorder.runDir, "visibility-otel.json");
    const exported = await exportVisibilityOtel({
      events: session.recorder.events,
      outputPath,
      serviceName: "ToolGuard local test"
    });

    expect(exported.schemaVersion).toBe(CANONICAL_VISIBILITY_SCHEMA_VERSION);
    expect(exported.format).toBe("opentelemetry-resource-spans-json");
    expect(exported.requiresCredentials).toBe(false);
    expect(exported.resourceSpans[0]?.resource.attributes).toEqual(
      expect.arrayContaining([
        { key: "service.name", value: { stringValue: "ToolGuard local test" } },
        { key: "toolguard.visibility.schema_version", value: { stringValue: CANONICAL_VISIBILITY_SCHEMA_VERSION } }
      ])
    );

    const spans = exported.resourceSpans.flatMap((resourceSpan) => resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans));
    expect(
      spans.map((span) => {
        const value = span.attributes.find((attribute) => attribute.key === "toolguard.event.type")?.value;
        return value && "stringValue" in value ? value.stringValue : undefined;
      })
    ).toEqual(expect.arrayContaining(["run.started", "tool.call.started", "tool.call.failed", "evidence.artifact.created"]));
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: { code: 2, message: "non_zero_exit" },
          attributes: expect.arrayContaining([{ key: "toolguard.failure.type", value: { stringValue: "non_zero_exit" } }])
        })
      ])
    );
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.arrayContaining([
            { key: "toolguard.evidence.artifact_id", value: { stringValue: expect.stringMatching(/^artifact_/) } }
          ])
        })
      ])
    );

    const onDisk = await readFile(outputPath, "utf8");
    expect(onDisk).toContain("opentelemetry-resource-spans-json");
    expect(onDisk).not.toContain("A".repeat(32));
    expect(onDisk).not.toContain("B".repeat(48));
    expect(onDisk).not.toMatch(/authorization|api[_-]?key/i);
  });

  it("imports valid JSONL visibility events as imported evidence and reports safe validation errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-jsonl-import-"));
    const source = new CoreSession({ evidenceRoot: root, runId: createId("run") });
    const call = makeToolCall(source.runId);
    await source.mediateSuccessfulCall(call, { ok: true });

    const validEvent = source.recorder.events.find((event) => event.type === "tool.call.completed") as CoreEvent;
    const jsonl = [
      JSON.stringify(validEvent),
      "{not json",
      JSON.stringify({ ...validEvent, eventId: createId("event"), schemaVersion: "legacy.visibility.v0" }),
      JSON.stringify({ ...validEvent, eventId: createId("event"), summary: `leaked sk-${"C".repeat(48)}` })
    ].join("\n");

    const targetRoot = await mkdtemp(path.join(tmpdir(), "toolguard-jsonl-import-target-"));
    const target = new CoreSession({ evidenceRoot: targetRoot, runId: validEvent.runId });
    const imported = await importVisibilityEventsJsonl({
      jsonl,
      recorder: target.recorder,
      sourceLabel: "external-jsonl"
    });

    expect(imported.valid).toBe(false);
    expect(imported.accepted).toBe(2);
    expect(imported.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 2, code: "invalid_json" }),
        expect.objectContaining({ line: 3, code: "unsupported_schema_version" })
      ])
    );
    expect(imported.errors.map((error) => error.message).join("\n")).not.toContain("C".repeat(48));
    expect(imported.events).toHaveLength(2);
    expect(imported.events[0]).toMatchObject({
      schemaVersion: CANONICAL_VISIBILITY_SCHEMA_VERSION,
      visibility: {
        schemaVersion: CANONICAL_VISIBILITY_SCHEMA_VERSION,
        visibilityLevel: "imported",
        coverageClaim: "imported",
        routeType: "visibility-jsonl-import",
        routeId: "visibility-jsonl-import",
        evidenceScope: "transport",
        producingEvidence: false
      },
      data: expect.objectContaining({
        import: expect.objectContaining({
          sourceLabel: "external-jsonl",
          originalRouteType: "cli-supervised",
          evidenceScope: "transport",
          producingEvidence: false
        })
      })
    });

    const persisted = await readFile(target.recorder.eventsPath, "utf8");
    expect(persisted).toContain('"visibilityLevel":"imported"');
    expect(persisted).toContain('"routeType":"visibility-jsonl-import"');
    expect(persisted).toContain('"producingEvidence":false');
    expect(persisted).not.toContain("C".repeat(48));

    const handle = createCoreApiServer({ host: "127.0.0.1", port: 0, evidenceRoot: targetRoot, session: target, seedDirectRun: false });
    await handle.ready;
    const address = handle.server.address();
    expect(typeof address).toBe("object");
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const response = await fetch(`${baseUrl}/api/integrations`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        routeCoverage: Array<{ routeType: string; producingEvidence: boolean; evidenceScope?: string; available?: boolean }>;
      };
      expect(payload.routeCoverage.find((row) => row.routeType === "visibility-jsonl-import")).toMatchObject({
        evidenceScope: "transport",
        producingEvidence: false
      });
      expect(payload.routeCoverage.find((row) => row.routeType === "cli-supervised")).toMatchObject({
        producingEvidence: false
      });
      expect(payload.routeCoverage.find((row) => row.routeType === "cli-supervised")?.available).not.toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("imports JSONL from a local file path with schema-version validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-jsonl-import-file-"));
    const source = new CoreSession({ evidenceRoot: root, runId: createId("run") });
    const call = makeToolCall(source.runId);
    await source.failToolCall(call, "non_zero_exit", ["safe failure"]);
    const importPath = path.join(root, "prior-events.jsonl");
    await writeFile(importPath, `${JSON.stringify(source.recorder.events.at(-1))}\n`, "utf8");

    const imported = await importVisibilityEventsJsonl({ inputPath: importPath });

    expect(imported.valid).toBe(true);
    expect(imported.accepted).toBe(1);
    expect(imported.events[0]?.schemaVersion).toBe(CANONICAL_VISIBILITY_SCHEMA_VERSION);
    expect(imported.events[0]?.visibility?.visibilityLevel).toBe("imported");
    expect(imported.events[0]?.visibility).toMatchObject({
      routeType: "visibility-jsonl-import",
      evidenceScope: "transport",
      producingEvidence: false
    });
  });
});
