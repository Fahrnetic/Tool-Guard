import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ToolRegistry,
  createCoreApiServer,
  createId,
  SIDECAR_PROTOCOL_VERSION,
  type CoreEvent,
  type FailureCard
} from "../src/index.js";

describe("local sidecar API", () => {
  it("routes framework adapter tool calls through Core with correlation and report evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-sidecar-"));
    const handle = createCoreApiServer({ port: 3665, evidenceRoot: root, seedDirectRun: false });
    await handle.ready;
    try {
      const runId = handle.session.runId;
      const traceId = createId("trace");
      const harnessId = createId("harness");
      const adapterId = createId("adapter");

      const response = await fetch("http://127.0.0.1:3665/api/sidecar/v1/tool-calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          adapterName: "toolguard-langgraph",
          harnessId,
          adapterId,
          toolName: "fixture.good",
          arguments: {},
          correlation: { runId, traceId, toolCallId: createId("toolcall"), attemptId: createId("attempt") }
        })
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; result?: { safeSummary: string } };
      expect(body.status).toBe("success");
      expect(body.result?.safeSummary).toContain("completed successfully");

      const events = (await readFile(handle.session.recorder.eventsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CoreEvent);
      expect(events.map((event) => event.type)).toContain("adapter.connected");
      expect(events.map((event) => event.type)).toContain("tool.call.completed");
      expect(events.every((event) => event.runId === runId)).toBe(true);
      expect(events.find((event) => event.type === "tool.call.started")).toMatchObject({
        traceId,
        harnessId,
        adapterId
      });

      const reportResponse = await fetch("http://127.0.0.1:3665/api/reports/export");
      expect(reportResponse.status).toBe(200);
      const report = (await reportResponse.json()) as { manifestValid: boolean; reportHtml: string };
      expect(report.manifestValid).toBe(true);
      expect(report.reportHtml).toContain("report.html");
    } finally {
      await handle.close();
    }
  });

  it("rejects incompatible sidecar protocol versions with a fail-closed Failure Card", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-sidecar-"));
    const handle = createCoreApiServer({ port: 3665, evidenceRoot: root, seedDirectRun: false });
    await handle.ready;
    try {
      const response = await fetch("http://127.0.0.1:3665/api/sidecar/v1/tool-calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: "toolguard.sidecar.v0",
          toolName: "fixture.good",
          arguments: {}
        })
      });

      expect(response.status).toBe(426);
      const body = (await response.json()) as { status: string; failureCard: FailureCard };
      expect(body.status).toBe("failure");
      expect(body.failureCard).toMatchObject({
        failureType: "sidecar_protocol_error",
        rawDetailsSeparated: true
      });
      const events = handle.session.recorder.events;
      expect(events.map((event) => event.type)).toContain("tool.call.failed");
      expect(events.map((event) => event.type)).toContain("evidence.artifact.created");
    } finally {
      await handle.close();
    }
  });

  it("fails closed for incomplete sidecar schemas without invoking default fixtures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-sidecar-"));
    const registry = new ToolRegistry();
    let invocationCount = 0;
    registry.register({
      toolName: "fixture.good",
      title: "Instrumented fixture",
      description: "Would be unsafe to invoke for malformed sidecar requests.",
      protocol: "fixture",
      downstreamServerId: createId("server"),
      inputSchema: { type: "object" },
      destructiveRisk: "none",
      execute: () => {
        invocationCount += 1;
        return { ok: true };
      }
    });
    const handle = createCoreApiServer({ port: 3665, evidenceRoot: root, registry, seedDirectRun: false });
    await handle.ready;
    try {
      for (const requestBody of [
        { protocolVersion: SIDECAR_PROTOCOL_VERSION, arguments: {} },
        { protocolVersion: SIDECAR_PROTOCOL_VERSION, toolName: 42, arguments: {} },
        { protocolVersion: SIDECAR_PROTOCOL_VERSION, toolName: "fixture.good", arguments: null }
      ]) {
        const response = await fetch("http://127.0.0.1:3665/api/sidecar/v1/tool-calls", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody)
        });
        expect(response.status).toBe(400);
        const body = (await response.json()) as { status: string; failureCard: FailureCard };
        expect(body.status).toBe("failure");
        expect(body.failureCard.failureType).toBe("sidecar_protocol_error");
      }

      expect(invocationCount).toBe(0);
      const events = handle.session.recorder.events;
      expect(events.filter((event) => event.type === "tool.call.failed")).toHaveLength(3);
      expect(events.filter((event) => event.type === "evidence.artifact.created")).toHaveLength(3);
      expect(events.map((event) => event.summary).join("\n")).not.toContain("Tool call completed: fixture.good");
    } finally {
      await handle.close();
    }
  });

  it("records malformed JSON and oversized sidecar bodies as report-visible failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-sidecar-"));
    const handle = createCoreApiServer({ port: 3665, evidenceRoot: root, seedDirectRun: false });
    await handle.ready;
    try {
      const malformed = await fetch("http://127.0.0.1:3665/api/sidecar/v1/tool-calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json"
      });
      expect(malformed.status).toBe(400);
      expect(((await malformed.json()) as { failureCard: FailureCard }).failureCard.failureType).toBe(
        "sidecar_protocol_error"
      );

      const oversized = await fetch("http://127.0.0.1:3665/api/sidecar/v1/tool-calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(256 * 1024 + 1)
      });
      expect(oversized.status).toBe(413);
      expect(((await oversized.json()) as { failureCard: FailureCard }).failureCard.failureType).toBe(
        "sidecar_protocol_error"
      );

      const events = handle.session.recorder.events;
      expect(events.filter((event) => event.type === "tool.call.failed")).toHaveLength(2);
      expect(events.filter((event) => event.type === "evidence.artifact.created")).toHaveLength(2);

      const reportResponse = await fetch("http://127.0.0.1:3665/api/reports/export");
      expect(reportResponse.status).toBe(200);
      const report = (await reportResponse.json()) as { manifestValid: boolean; reportHtml: string };
      expect(report.manifestValid).toBe(true);
      const reportHtml = await readFile(report.reportHtml, "utf8");
      expect(reportHtml).toContain("sidecar_protocol_error");
      expect(reportHtml).toContain("Failure Cards");
    } finally {
      await handle.close();
    }
  });

  it("serves replay metadata, blocks real-world replay, and exports report listings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-replay-report-"));
    const handle = createCoreApiServer({ port: 0, evidenceRoot: root, seedDirectRun: false });
    await handle.ready;
    const address = handle.server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected test server address");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const metadataResponse = await fetch(`${origin}/api/replay`);
      expect(metadataResponse.status).toBe(200);
      const metadata = (await metadataResponse.json()) as { fixtures: { id: string; fixtureOnly: boolean; safe: boolean }[] };
      expect(metadata.fixtures).toContainEqual(expect.objectContaining({ id: "fixture.wrong-cwd", fixtureOnly: true, safe: true }));
      expect(metadata.fixtures).toContainEqual(expect.objectContaining({ id: "real-world.rm-rf", fixtureOnly: false, safe: false }));

      const blockedResponse = await fetch(`${origin}/api/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolName: "real-world.rm-rf",
          sourceRunId: handle.session.runId,
          fixtureOnly: false,
          mode: "real-world",
          destructive: true
        })
      });
      expect(blockedResponse.status).toBe(409);
      const blocked = (await blockedResponse.json()) as { status: string; reason: string };
      expect(blocked.status).toBe("blocked");
      expect(blocked.reason).toContain("fixture-only");

      const replayResponse = await fetch(`${origin}/api/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolName: "fixture.wrong-cwd",
          sourceRunId: handle.session.runId,
          fixtureOnly: true
        })
      });
      expect(replayResponse.status).toBe(200);
      const replay = (await replayResponse.json()) as { status: string; sourceRunId: string; freshCorrelation?: { traceId: string; toolCallId: string } };
      expect(replay.status).toBe("failed");
      expect(replay.sourceRunId).toBe(handle.session.runId);
      expect(replay.freshCorrelation?.traceId).toMatch(/^trace_/);
      expect(replay.freshCorrelation?.toolCallId).toMatch(/^toolcall_/);

      const exportResponse = await fetch(`${origin}/api/reports/export`);
      expect(exportResponse.status).toBe(200);
      const reportsResponse = await fetch(`${origin}/api/reports`);
      expect(reportsResponse.status).toBe(200);
      const reports = (await reportsResponse.json()) as { reports: { reportHtml: string; manifestJson: string; artifactHashList: string; redactionSummaryPath: string; manifestValid: boolean; narrative: string }[] };
      expect(reports.reports[0]).toMatchObject({ manifestValid: true });
      expect(reports.reports[0]?.reportHtml).toContain("report.html");
      expect(reports.reports[0]?.manifestJson).toContain("manifest.json");
      expect(reports.reports[0]?.artifactHashList).toContain("artifact-hashes.json");
      expect(reports.reports[0]?.redactionSummaryPath).toContain("redaction-summary.json");
      expect(reports.reports[0]?.narrative).toContain("fixture.wrong-cwd");
    } finally {
      await handle.close();
    }
  });
});
