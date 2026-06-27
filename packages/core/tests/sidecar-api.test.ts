import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCoreApiServer, createId, SIDECAR_PROTOCOL_VERSION, type CoreEvent, type FailureCard } from "../src/index.js";

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
    } finally {
      await handle.close();
    }
  });
});
