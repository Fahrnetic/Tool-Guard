import { access, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ToolRegistry,
  CoreSession,
  createCoreApiServer,
  createId,
  SIDECAR_PROTOCOL_VERSION,
  type CoreEvent,
  type FailureCard,
  type ToolCall
} from "../src/index.js";

describe("local sidecar API", () => {
  it("backs validation dashboard process hygiene with a local approved-port probe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-validation-dashboard-"));
    const leakedFixturePort = 3669;
    const leakedFixture = createServer();
    const handle = createCoreApiServer({ port: 0, evidenceRoot: root, seedDirectRun: false });

    await new Promise<void>((resolve, reject) => {
      leakedFixture.once("error", reject);
      leakedFixture.listen(leakedFixturePort, "127.0.0.1", () => {
        leakedFixture.off("error", reject);
        resolve();
      });
    });
    await handle.ready;
    const address = handle.server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected test server address");
    }

    try {
      const origin = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${origin}/api/validation-dashboard`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        approvedPorts: number[];
        processHygiene: {
          status: string;
          openApprovedPorts: number[];
          expectedOpenPorts: number[];
          unexpectedOpenPorts: number[];
          currentPid: number;
          detail: string;
        };
        checks: { id: string; status: string; detail: string }[];
      };
      const processHygieneCheck = payload.checks.find((check) => check.id === "process-hygiene");

      expect(payload.approvedPorts).toEqual([3660, 3661, 3662, 3663, 3664, 3665, 3666, 3667, 3668, 3669]);
      expect(payload.processHygiene.status).toBe("fail");
      expect(payload.processHygiene.openApprovedPorts).toContain(leakedFixturePort);
      expect(payload.processHygiene.unexpectedOpenPorts).toContain(leakedFixturePort);
      expect(payload.processHygiene.currentPid).toBe(process.pid);
      expect(payload.processHygiene.detail).toContain("unexpected ToolGuard-owned approved loopback ports still open");
      expect(processHygieneCheck).toMatchObject({ id: "process-hygiene", status: "fail" });
      expect(processHygieneCheck?.detail).toContain(String(leakedFixturePort));
    } finally {
      await handle.close();
      await new Promise<void>((resolve, reject) => {
        leakedFixture.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("serves deterministic topology and narrative from Core events and the side-effect ledger", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-topology-api-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId, retry: { maxRetries: 1 } });
    const call: ToolCall = {
      runId,
      traceId: createId("trace"),
      parentId: createId("parent"),
      harnessId: createId("harness"),
      adapterId: createId("adapter"),
      downstreamServerId: createId("server"),
      toolCallId: createId("toolcall"),
      attemptId: createId("attempt"),
      policyDecisionId: createId("policy"),
      toolName: "fixture.topology-failure",
      arguments: {},
      deadlineMs: 1000,
      idempotency: "idempotent",
      sourcePath: "non-mcp-direct"
    };
    const registry = new ToolRegistry();
    registry.register({
      toolName: call.toolName,
      title: "Topology failure fixture",
      description: "Fails with raw downstream-looking content that must not appear in narrative.",
      protocol: "fixture",
      downstreamServerId: call.downstreamServerId,
      inputSchema: { type: "object" },
      destructiveRisk: "none",
      execute: () => {
        throw new Error("RAW_STDERR_SECRET api_key=topologysecret1234567890");
      }
    });
    const handle = createCoreApiServer({ port: 0, evidenceRoot: root, session, registry, seedDirectRun: false });
    await handle.ready;
    const address = handle.server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected test server address");
    }
    try {
      await session.executeToolCall(registry, call);
      const origin = `http://127.0.0.1:${address.port}`;
      const topologyResponse = await fetch(`${origin}/api/topology/${encodeURIComponent(runId)}`);
      const narrativeResponse = await fetch(`${origin}/api/narrative/${encodeURIComponent(runId)}`);
      const topologyAgainResponse = await fetch(`${origin}/api/topology/${encodeURIComponent(runId)}`);
      const narrativeAgainResponse = await fetch(`${origin}/api/narrative/${encodeURIComponent(runId)}`);
      expect(topologyResponse.status).toBe(200);
      expect(narrativeResponse.status).toBe(200);
      const topology = (await topologyResponse.json()) as {
        nodes: { type: string; status: string; correlation: Record<string, string> }[];
        edges: { type: string; source: string; target: string }[];
        generatedFrom: { eventCount: number; ledgerCount: number };
      };
      const narrative = (await narrativeResponse.json()) as { text: string; sections: Record<string, string> };
      const topologyAgain = await topologyAgainResponse.json();
      const narrativeAgain = await narrativeAgainResponse.json();

      expect(topology.nodes.map((node) => node.type)).toEqual(
        expect.arrayContaining([
          "harness",
          "adapter",
          "downstream-server",
          "downstream-tool",
          "policy-decision",
          "attempt",
          "side-effect",
          "artifact"
        ])
      );
      expect(topology.edges.map((edge) => edge.type)).toEqual(
        expect.arrayContaining(["routed-through", "produced-artifact", "caused-by"])
      );
      expect(topology.nodes.some((node) => node.status === "failed" || node.status === "degraded")).toBe(true);
      expect(topology.nodes.every((node) => node.correlation.runId === runId)).toBe(true);
      expect(topology.generatedFrom.ledgerCount).toBeGreaterThan(0);
      expect(topologyAgain).toEqual(topology);

      expect(narrative.text).toContain("Root cause:");
      expect(narrative.text).toContain("Blast radius:");
      expect(narrative.text).toContain("Side effects:");
      expect(narrative.text).toContain("Recovery status:");
      expect(narrative.text).toContain("Next safe action:");
      expect(JSON.stringify(narrative)).not.toContain("RAW_STDERR_SECRET");
      expect(JSON.stringify(narrative)).not.toContain("topologysecret1234567890");
      expect(narrativeAgain).toEqual(narrative);

      await expect(access(path.join(root, runId, "topology.json"))).resolves.toBeUndefined();
      await expect(access(path.join(root, runId, "narrative.json"))).resolves.toBeUndefined();
      expect(handle.session.recorder.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["topology.generated", "narrative.generated"])
      );
    } finally {
      await handle.close();
    }
  });

  it("exposes deterministic empty and delayed topology demo runs for real UI validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-topology-demo-states-"));
    const handle = createCoreApiServer({ port: 0, evidenceRoot: root, seedDirectRun: false });
    await handle.ready;
    const address = handle.server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected test server address");
    }
    try {
      const origin = `http://127.0.0.1:${address.port}`;
      const emptyTopologyResponse = await fetch(`${origin}/api/topology/demo-empty`);
      const emptyNarrativeResponse = await fetch(`${origin}/api/narrative/demo-empty`);
      const started = Date.now();
      const loadingTopologyResponse = await fetch(`${origin}/api/topology/demo-loading`);
      const elapsedMs = Date.now() - started;

      expect(emptyTopologyResponse.status).toBe(200);
      expect(emptyNarrativeResponse.status).toBe(200);
      expect(loadingTopologyResponse.status).toBe(200);
      const emptyTopology = (await emptyTopologyResponse.json()) as { runId: string; nodes: unknown[]; edges: unknown[]; summary: { nodes: number } };
      const emptyNarrative = (await emptyNarrativeResponse.json()) as { runId: string; text: string };
      const loadingTopology = (await loadingTopologyResponse.json()) as { runId: string };

      expect(emptyTopology.runId).toBe("demo-empty");
      expect(emptyTopology.nodes).toEqual([]);
      expect(emptyTopology.edges).toEqual([]);
      expect(emptyTopology.summary.nodes).toBe(0);
      expect(emptyNarrative.text).toContain("deterministic empty fixture run");
      expect(loadingTopology.runId).toBe(handle.session.runId);
      expect(elapsedMs).toBeGreaterThanOrEqual(1_400);
    } finally {
      await handle.close();
    }
  });

  it("serves redacted raw stdout and stderr content with truncation metadata in failure and trace payloads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-raw-api-"));
    const runId = createId("run");
    const session = new CoreSession({ evidenceRoot: root, runId });
    const call: ToolCall = {
      runId,
      traceId: createId("trace"),
      parentId: createId("parent"),
      harnessId: createId("harness"),
      adapterId: createId("adapter"),
      downstreamServerId: createId("server"),
      toolCallId: createId("toolcall"),
      attemptId: createId("attempt"),
      policyDecisionId: createId("policy"),
      toolName: "fixture.raw-streams",
      arguments: {},
      deadlineMs: 1000,
      idempotency: "idempotent",
      sourcePath: "non-mcp-direct"
    };
    const registry = new ToolRegistry();
    registry.register({
      toolName: "fixture.raw-streams",
      title: "Raw stream fixture",
      description: "Records stdout and stderr before failing.",
      protocol: "fixture",
      downstreamServerId: call.downstreamServerId,
      inputSchema: { type: "object" },
      destructiveRisk: "none",
      execute: async ({ call: activeCall }) => {
        const stdout = await session.recordRawArtifact(activeCall, {
          kind: "raw-stdout",
          fileName: `${activeCall.toolCallId}.stdout.txt`,
          content: "stdout first line\nAuthorization: Bearer stdout_secret_token_1234567890\nstdout second line",
          redacted: true
        });
        await session.emitOutputSanitized(activeCall, "Output limit enforced for test stdout.", {
          reason: "output_limit",
          outputLimitBytes: 32,
          artifactId: stdout.artifactId
        });
        await session.recordRawArtifact(activeCall, {
          kind: "raw-stderr",
          fileName: `${activeCall.toolCallId}.stderr.txt`,
          content: "stderr first line\napi_key=stderrsecretvalue1234567890\nstderr second line",
          redacted: true
        });
        throw new Error("fixture failed after streams");
      }
    });
    const handle = createCoreApiServer({ port: 0, evidenceRoot: root, session, registry, seedDirectRun: false });
    await handle.ready;
    const address = handle.server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected test server address");
    }
    try {
      await session.executeToolCall(registry, call);
      const origin = `http://127.0.0.1:${address.port}`;

      const failuresResponse = await fetch(`${origin}/api/failures`, { headers: { host: "attacker.example:9999" } });
      expect(failuresResponse.status).toBe(200);
      const failures = (await failuresResponse.json()) as {
        failures: {
          evidenceLinks: { href: string }[];
          rawStdout: { content: string; truncated: boolean; outputLimitBytes?: number; redacted: boolean }[];
          rawStderr: { content: string; truncated: boolean; redacted: boolean }[];
        }[];
      };
      expect(failures.failures[0]?.rawStdout[0]).toMatchObject({
        truncated: true,
        outputLimitBytes: 32,
        redacted: true
      });
      expect(failures.failures[0]?.rawStdout[0]?.content).toContain("stdout first line\n");
      expect(failures.failures[0]?.rawStdout[0]?.content).toContain("[REDACTED:bearer-token:");
      expect(failures.failures[0]?.rawStdout[0]?.content).not.toContain("stdout_secret_token_1234567890");
      expect(failures.failures[0]?.rawStderr[0]).toMatchObject({
        truncated: false,
        redacted: true
      });
      expect(failures.failures[0]?.rawStderr[0]?.content).toContain("[REDACTED:api-key-assignment:");
      expect(failures.failures[0]?.rawStderr[0]?.content).not.toContain("stderrsecretvalue1234567890");
      expect(failures.failures[0]?.evidenceLinks.every((link) => link.href.startsWith(origin))).toBe(true);
      expect(JSON.stringify(failures)).not.toContain("attacker.example");

      const traceResponse = await fetch(`${origin}/api/traces/${encodeURIComponent(call.traceId)}`);
      expect(traceResponse.status).toBe(200);
      const trace = (await traceResponse.json()) as {
        correlation: Record<string, string>;
        rawStdout: { artifactId: string; content: string; truncated: boolean; redacted: boolean }[];
        rawStderr: { content: string; truncated: boolean; redacted: boolean }[];
      };
      expect(trace.correlation).toMatchObject({
        runId,
        traceId: call.traceId,
        parentId: call.parentId,
        harnessId: call.harnessId,
        adapterId: call.adapterId,
        downstreamServerId: call.downstreamServerId,
        toolCallId: call.toolCallId,
        attemptId: call.attemptId,
        policyDecisionId: call.policyDecisionId
      });
      expect(trace.rawStdout[0]?.content).toContain("stdout first line\n");
      expect(trace.rawStdout[0]?.content).toContain("[REDACTED:bearer-token:");
      expect(trace.rawStdout[0]?.content).not.toContain("stdout_secret_token_1234567890");
      expect(trace.rawStderr[0]?.content).toContain("[REDACTED:api-key-assignment:");
      expect(trace.rawStderr[0]?.content).not.toContain("stderrsecretvalue1234567890");
      expect(JSON.stringify(trace)).not.toContain("stderrsecretvalue1234567890");

      const artifactHref = `${origin}/api/reports/${runId}/artifacts/${trace.rawStdout[0]?.artifactId}`;
      const artifactResponse = await fetch(artifactHref ?? "");
      expect(artifactResponse.status).toBe(200);
      expect(artifactResponse.headers.get("x-toolguard-redacted")).toBe("true");
      const artifactBody = await artifactResponse.text();
      expect(artifactBody).not.toContain("stdout_secret_token_1234567890");
      expect(artifactBody).not.toContain("stderrsecretvalue1234567890");
    } finally {
      await handle.close();
    }
  });

  it("serves distinct harness, adapter, downstream server, and downstream tool health rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toolguard-health-"));
    const handle = createCoreApiServer({ port: 0, evidenceRoot: root });
    await handle.ready;
    const address = handle.server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected test server address");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        summary: { downstreamServers: number; downstreamTools: number };
        rows: {
          layer: string;
          status: string;
          preflight: string;
          latencyMs: number;
          failureType: string;
          retryable: boolean;
          circuitState: string;
          remediation: string;
          downstreamServerId?: string;
        }[];
      };

      expect(payload.rows.map((row) => row.layer)).toEqual(
        expect.arrayContaining(["harness", "adapter", "downstream server", "downstream tool"])
      );
      expect(payload.summary.downstreamServers).toBeGreaterThan(0);
      expect(payload.summary.downstreamTools).toBeGreaterThan(0);
      expect(payload.rows.filter((row) => row.layer === "downstream server").length).toBe(payload.summary.downstreamServers);
      expect(payload.rows.filter((row) => row.layer === "downstream tool").length).toBe(payload.summary.downstreamTools);
      expect(payload.rows.every((row) => typeof row.preflight === "string" && row.preflight.length > 0)).toBe(true);
      expect(payload.rows.every((row) => typeof row.latencyMs === "number")).toBe(true);
      expect(payload.rows.every((row) => typeof row.failureType === "string" && row.failureType.length > 0)).toBe(true);
      expect(payload.rows.every((row) => typeof row.retryable === "boolean")).toBe(true);
      expect(payload.rows.every((row) => typeof row.circuitState === "string" && row.circuitState.length > 0)).toBe(true);
      expect(payload.rows.every((row) => typeof row.remediation === "string" && row.remediation.length > 0)).toBe(true);
      expect(new Set(payload.rows.filter((row) => row.layer === "downstream server").map((row) => row.downstreamServerId))).toEqual(
        new Set(payload.rows.filter((row) => row.layer === "downstream tool").map((row) => row.downstreamServerId))
      );
    } finally {
      await handle.close();
    }
  });

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
      const reports = (await reportsResponse.json()) as { reports: { reportHtml: string; reportUrl: string; manifestJson: string; manifestUrl: string; artifactHashList: string; artifactHashUrl: string; redactionSummaryPath: string; redactionSummaryUrl: string; manifestValid: boolean; narrative: string; artifacts: { artifactId: string; artifactUrl: string }[] }[] };
      expect(reports.reports[0]).toMatchObject({ manifestValid: true });
      expect(reports.reports[0]?.reportHtml).toContain("report.html");
      expect(reports.reports[0]?.manifestJson).toContain("manifest.json");
      expect(reports.reports[0]?.artifactHashList).toContain("artifact-hashes.json");
      expect(reports.reports[0]?.redactionSummaryPath).toContain("redaction-summary.json");
      expect(reports.reports[0]?.reportUrl).toBe(`${origin}/api/reports/${handle.session.runId}/files/report.html`);
      expect(reports.reports[0]?.manifestUrl).toBe(`${origin}/api/reports/${handle.session.runId}/files/manifest.json`);
      expect(reports.reports[0]?.artifactHashUrl).toBe(`${origin}/api/reports/${handle.session.runId}/files/artifact-hashes.json`);
      expect(reports.reports[0]?.redactionSummaryUrl).toBe(`${origin}/api/reports/${handle.session.runId}/files/redaction-summary.json`);
      expect(JSON.stringify(reports)).not.toContain("file://");
      expect(reports.reports[0]?.narrative).toContain("fixture.wrong-cwd");

      const reportFileResponse = await fetch(reports.reports[0]?.reportUrl ?? "");
      expect(reportFileResponse.status).toBe(200);
      expect(reportFileResponse.headers.get("content-type")).toContain("text/html");
      expect(await reportFileResponse.text()).toContain("ToolGuard Evidence Report");

      const manifestFileResponse = await fetch(reports.reports[0]?.manifestUrl ?? "");
      expect(manifestFileResponse.status).toBe(200);
      expect(await manifestFileResponse.json()).toMatchObject({ runId: handle.session.runId });

      const artifactHashesResponse = await fetch(reports.reports[0]?.artifactHashUrl ?? "");
      expect(artifactHashesResponse.status).toBe(200);
      expect(await artifactHashesResponse.json()).toEqual(expect.arrayContaining([expect.objectContaining({ artifactId: expect.stringMatching(/^artifact_/) })]));

      const redactionSummaryResponse = await fetch(reports.reports[0]?.redactionSummaryUrl ?? "");
      expect(redactionSummaryResponse.status).toBe(200);
      expect(await redactionSummaryResponse.json()).toMatchObject({ redactionCount: expect.any(Number) });

      const artifactUrl = reports.reports[0]?.artifacts[0]?.artifactUrl;
      expect(artifactUrl).toContain(`${origin}/api/reports/${handle.session.runId}/artifacts/artifact_`);
      const artifactResponse = await fetch(artifactUrl ?? "");
      expect(artifactResponse.status).toBe(200);
    } finally {
      await handle.close();
    }
  });
});
