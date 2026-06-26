import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createChaosFixtures, registerChaosFixtures } from "./chaos-fixtures.js";
import { createId } from "./ids.js";
import { ToolRegistry } from "./registry.js";
import { redactString } from "./redaction.js";
import { CoreSession } from "./session.js";
import type { ToolCall } from "./types.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "toolplane";
  if (command === "raw-failure") {
    await rawFailureDemo();
    return;
  }
  if (command === "toolplane") {
    await toolplaneDemo();
    return;
  }
  throw new Error(`Unknown demo command: ${command}`);
}

async function rawFailureDemo(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "toolguard-raw-demo-"));
  const fixture = createChaosFixtures({ sandboxRoot: root }).find((tool) => tool.toolName === "fixture.malformed-json");
  if (!fixture) {
    throw new Error("Raw failure fixture is unavailable.");
  }

  console.log("ToolGuard raw failure demo");
  console.log(`Fixture target: ${fixture.toolName}`);
  console.log("Mediation: disabled");
  try {
    await fixture.execute({ signal: new AbortController().signal, call: makeCall(createId("run"), fixture.downstreamServerId) });
  } catch (error) {
    console.log("Raw downstream failure:");
    console.log(error instanceof Error ? error.message : String(error));
    console.log("No Failure Card, no recovery guidance, no redaction summary.");
    return;
  }
  throw new Error("Expected deterministic raw fixture failure.");
}

async function toolplaneDemo(): Promise<void> {
  const root = path.join(process.cwd(), "runs");
  const runId = createId("run");
  const session = new CoreSession({ evidenceRoot: root, runId, retry: { maxRetries: 1 } });
  const registry = new ToolRegistry();
  registerChaosFixtures(registry, { sandboxRoot: root });
  const tool = registry.get("fixture.prompt-injection-output");
  if (!tool) {
    throw new Error("ToolGuard demo fixture is unavailable.");
  }

  const result = await session.executeToolCall(
    registry,
    makeCall(runId, tool.downstreamServerId, { toolName: "fixture.prompt-injection-output" })
  );
  const report = await session.exportReport();

  console.log("ToolGuard mediated failure demo");
  console.log(`runId: ${runId}`);
  console.log(`evidenceDir: ${session.recorder.runDir}`);
  console.log(`eventsJsonl: ${session.recorder.eventsPath}`);
  console.log(`reportHtml: ${report.reportPath}`);
  console.log(`manifestJson: ${report.manifestPath}`);
  if ("failureType" in result) {
    console.log("Failure Card:");
    console.log(`  toolName: ${result.toolName}`);
    console.log(`  failureType: ${result.failureType}`);
    console.log(`  retryable: ${result.retryable}`);
    console.log(`  doNotRetrySameCall: ${result.doNotRetrySameCall}`);
    console.log(`  safeSummary: ${redactString(result.safeSummary)}`);
    console.log(`  evidenceArtifacts: ${result.evidenceLinks.map((link) => link.artifactId).join(", ")}`);
  } else {
    console.log(`Result: ${redactString(result.safeSummary)}`);
  }
}

function makeCall(runId: ToolCall["runId"], downstreamServerId: ToolCall["downstreamServerId"], overrides: Partial<ToolCall> = {}): ToolCall {
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
    toolName: "fixture.malformed-json",
    arguments: {},
    deadlineMs: 100,
    idempotency: "idempotent",
    sourcePath: "non-mcp-direct",
    ...overrides
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
