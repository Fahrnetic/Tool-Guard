import { EventBus, type CoreEvent, type CoreEventType } from "./events.js";
import { EvidenceRecorder } from "./evidence.js";
import { createId, type StableId } from "./ids.js";
import type { ToolRegistry } from "./registry.js";
import type {
  EvidenceArtifact,
  FailureCard,
  JsonValue,
  PreflightFinding,
  ToolCall,
  ToolResult
} from "./types.js";

export interface CoreSessionOptions {
  readonly evidenceRoot: string;
  readonly runId: StableId;
  readonly clock?: () => Date;
  readonly outputLimitBytes?: number;
}

export class CoreSession {
  readonly #bus = new EventBus();
  readonly #recorder: EvidenceRecorder;
  readonly #clock: () => Date;
  readonly #runId: StableId;
  readonly #outputLimitBytes: number;
  #sequence = 0;

  constructor(options: CoreSessionOptions) {
    this.#runId = options.runId;
    this.#recorder = new EvidenceRecorder({
      rootDir: options.evidenceRoot,
      runId: options.runId
    });
    this.#clock = options.clock ?? (() => new Date());
    this.#outputLimitBytes = options.outputLimitBytes ?? 64 * 1024;
  }

  get runId(): StableId {
    return this.#runId;
  }

  get bus(): EventBus {
    return this.#bus;
  }

  get recorder(): EvidenceRecorder {
    return this.#recorder;
  }

  async preflight(
    registry: ToolRegistry,
    context: {
      readonly runId: StableId;
      readonly traceId: StableId;
      readonly parentId?: StableId;
      readonly harnessId: StableId;
      readonly adapterId: StableId;
    }
  ): Promise<PreflightFinding[]> {
    await this.#emitContext("server.preflight.started", context, "Core preflight started", {
      data: { toolCount: registry.list().length }
    });

    const findings: PreflightFinding[] = [];
    for (const tool of registry.list()) {
      try {
        const result = tool.preflight
          ? await tool.preflight()
          : { status: "healthy" as const, summary: `Tool ${tool.toolName} is registered.` };
        findings.push({
          downstreamServerId: tool.downstreamServerId,
          toolName: tool.toolName,
          status: result.status,
          summary: result.summary,
          ...(result.remediation ? { remediation: result.remediation } : {})
        });
      } catch (error) {
        findings.push({
          downstreamServerId: tool.downstreamServerId,
          toolName: tool.toolName,
          status: "failed",
          summary: "Preflight probe failed.",
          remediation: error instanceof Error ? error.message : "Inspect downstream fixture health."
        });
      }
    }

    await this.#emitContext("server.preflight.completed", context, "Core preflight completed", {
      data: { findings: findings as unknown as JsonValue }
    });

    return findings;
  }

  async executeToolCall(
    registry: ToolRegistry,
    call: ToolCall,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<ToolResult | FailureCard> {
    await this.#emit("run.started", call, "Run started");
    await this.#emit("tool.call.started", call, `Tool call started: ${call.toolName}`);
    await this.#emit("server.preflight.started", call, `Preflight started: ${call.toolName}`);

    const tool = registry.get(call.toolName);
    if (!tool) {
      await this.#emit("server.preflight.completed", call, `Preflight failed: unknown tool ${call.toolName}`, {
        data: { status: "failed", reason: "unknown_tool" }
      });
      const failure = await this.#recordFailure(call, "unknown_tool", "Registered tool identity was not found.", [
        `Unknown tool: ${call.toolName}`
      ]);
      await this.#emit("run.completed", call, "Run completed");
      return failure;
    }

    const validation = registry.validateCall(call);
    if (!validation.valid) {
      await this.#emit("server.preflight.completed", call, `Preflight failed: invalid arguments for ${call.toolName}`, {
        data: { status: "failed", reason: "invalid_arguments", errors: validation.errors as unknown as JsonValue }
      });
      const failure = await this.#recordFailure(call, "invalid_arguments", "Tool arguments failed schema validation.", [
        ...validation.errors
      ]);
      await this.#emit("run.completed", call, "Run completed");
      return failure;
    }

    await this.#emit("server.preflight.completed", call, `Preflight completed: ${call.toolName}`, {
      data: { status: "healthy", reason: "registered_tool_and_arguments_valid" }
    });

    const controller = new AbortController();
    let abortReason: "timeout" | "cancellation" | undefined;
    const timeout =
      call.deadlineMs && call.deadlineMs > 0
        ? setTimeout(() => {
            abortReason = "timeout";
            controller.abort(new Error("deadline exceeded"));
          }, call.deadlineMs)
        : undefined;
    const externalAbort = (): void => {
      abortReason = "cancellation";
      controller.abort(new Error("cancelled"));
    };
    if (options.signal?.aborted) {
      externalAbort();
    } else {
      options.signal?.addEventListener("abort", externalAbort, { once: true });
    }

    try {
      const rawOutput = await executeWithAbort(() => tool.execute({ signal: controller.signal, call }), controller.signal);
      if (timeout) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", externalAbort);

      const artifact = await this.#recorder.writeArtifact({
        runId: call.runId,
        traceId: call.traceId,
        toolCallId: call.toolCallId,
        kind: "raw-result",
        fileName: `${call.toolCallId}.result.json`,
        content: rawOutput,
        redacted: false
      });
      await this.#emitArtifactCreated(call, artifact);

      const serialized = JSON.stringify(rawOutput);
      const overLimit = Buffer.byteLength(serialized, "utf8") > this.#outputLimitBytes;
      if (overLimit) {
        await this.#emit("output.sanitized", call, `Output limit enforced for ${call.toolName}`, {
          data: { reason: "output_limit", outputLimitBytes: this.#outputLimitBytes, artifactId: artifact.artifactId }
        });
      }

      const result: ToolResult = {
        toolName: call.toolName,
        output: overLimit ? { truncated: true, artifactId: artifact.artifactId } : rawOutput,
        safeSummary: overLimit
          ? `Tool ${call.toolName} completed successfully, but output was truncated for model safety.`
          : `Tool ${call.toolName} completed successfully.`,
        artifactIds: [artifact.artifactId]
      };
      await this.#emit("tool.call.completed", call, `Tool call completed: ${call.toolName}`, { data: result });
      await this.#emit("run.completed", call, "Run completed");
      return result;
    } catch (error) {
      if (timeout) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", externalAbort);

      const failureType = controller.signal.aborted ? (abortReason ?? "cancellation") : "unknown";
      const failure = await this.#recordFailure(
        call,
        failureType,
        failureType === "timeout"
          ? "Tool execution exceeded its deadline."
          : failureType === "cancellation"
            ? "Tool execution was cancelled before completion."
            : "Tool execution failed.",
        [error instanceof Error ? error.message : String(error)]
      );
      await this.#emit("run.completed", call, "Run completed");
      return failure;
    }
  }

  async mediateSuccessfulCall(call: ToolCall, output: JsonValue): Promise<ToolResult> {
    await this.#emit("run.started", call, "Run started");
    await this.#emit("tool.call.started", call, `Tool call started: ${call.toolName}`);

    const artifact = await this.#recorder.writeArtifact({
      runId: call.runId,
      traceId: call.traceId,
      toolCallId: call.toolCallId,
      kind: "raw-result",
      fileName: `${call.toolCallId}.result.json`,
      content: output,
      redacted: false
    });

    await this.#emitArtifactCreated(call, artifact);

    const result: ToolResult = {
      toolName: call.toolName,
      output,
      safeSummary: `Tool ${call.toolName} completed successfully.`,
      artifactIds: [artifact.artifactId]
    };
    await this.#emit("tool.call.completed", call, `Tool call completed: ${call.toolName}`, { data: result });
    await this.#emit("run.completed", call, "Run completed");

    return result;
  }

  async #recordFailure(
    call: ToolCall,
    failureType: FailureCard["failureType"],
    likelyRootCause: string,
    rawDetails: readonly string[]
  ): Promise<FailureCard> {
    const artifact = await this.#recorder.writeArtifact({
      runId: call.runId,
      traceId: call.traceId,
      toolCallId: call.toolCallId,
      kind: "raw-stderr",
      fileName: `${call.toolCallId}.failure.txt`,
      content: rawDetails.join("\n"),
      redacted: false
    });
    await this.#emitArtifactCreated(call, artifact);

    const failure: FailureCard = {
      toolName: call.toolName,
      failureType,
      likelyRootCause,
      retryable: failureType === "timeout",
      doNotRetrySameCall: failureType !== "timeout",
      safeRecoveryOptions:
        failureType === "timeout"
          ? ["Retry with a larger deadline only if the operation is idempotent.", "Check downstream health."]
          : ["Correct the tool name or arguments before retrying.", "Inspect the referenced raw artifact if needed."],
      humanFix:
        failureType === "unknown_tool"
          ? "Register the tool before routing calls to it."
          : failureType === "invalid_arguments"
            ? "Update arguments to match the registered JSON schema."
            : "Inspect the downstream fixture and deadline settings.",
      evidenceLinks: [
        {
          artifactId: artifact.artifactId,
          href: artifact.relativePath,
          label: "Raw failure artifact"
        }
      ],
      safeSummary: `Tool ${call.toolName} failed with ${failureType}. Raw details are stored separately.`,
      rawDetailsSeparated: true
    };

    await this.#emit("tool.call.failed", call, `Tool call failed: ${call.toolName}`, { data: failure });
    return failure;
  }

  async #emitArtifactCreated(call: ToolCall, artifact: EvidenceArtifact): Promise<void> {
    await this.#emit("evidence.artifact.created", call, `Evidence artifact created: ${artifact.artifactId}`, {
      data: artifact,
      artifactId: artifact.artifactId
    });
  }

  async #emit(
    type: CoreEventType,
    call: ToolCall,
    summary: string,
    options: { readonly data?: CoreEvent["data"]; readonly artifactId?: StableId } = {}
  ): Promise<CoreEvent> {
    const event: CoreEvent = {
      eventId: createId("event"),
      type,
      occurredAt: this.#clock().toISOString(),
      sequence: ++this.#sequence,
      summary,
      runId: call.runId,
      traceId: call.traceId,
      ...(call.parentId ? { parentId: call.parentId } : {}),
      harnessId: call.harnessId,
      adapterId: call.adapterId,
      downstreamServerId: call.downstreamServerId,
      toolCallId: call.toolCallId,
      attemptId: call.attemptId,
      policyDecisionId: call.policyDecisionId,
      ...(options.artifactId ? { artifactId: options.artifactId } : {}),
      ...(options.data ? { data: options.data } : {})
    };

    await this.#recorder.appendEvent(event);
    this.#bus.publish(event);
    return event;
  }

  async #emitContext(
    type: CoreEventType,
    context: {
      readonly runId: StableId;
      readonly traceId: StableId;
      readonly parentId?: StableId;
      readonly harnessId?: StableId;
      readonly adapterId?: StableId;
      readonly downstreamServerId?: StableId;
      readonly toolCallId?: StableId;
      readonly attemptId?: StableId;
      readonly policyDecisionId?: StableId;
    },
    summary: string,
    options: { readonly data?: CoreEvent["data"]; readonly artifactId?: StableId } = {}
  ): Promise<CoreEvent> {
    const event: CoreEvent = {
      eventId: createId("event"),
      type,
      occurredAt: this.#clock().toISOString(),
      sequence: ++this.#sequence,
      summary,
      runId: context.runId,
      traceId: context.traceId,
      ...(context.parentId ? { parentId: context.parentId } : {}),
      ...(context.harnessId ? { harnessId: context.harnessId } : {}),
      ...(context.adapterId ? { adapterId: context.adapterId } : {}),
      ...(context.downstreamServerId ? { downstreamServerId: context.downstreamServerId } : {}),
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      ...(context.attemptId ? { attemptId: context.attemptId } : {}),
      ...(context.policyDecisionId ? { policyDecisionId: context.policyDecisionId } : {}),
      ...(options.artifactId ? { artifactId: options.artifactId } : {}),
      ...(options.data ? { data: options.data } : {})
    };

    await this.#recorder.appendEvent(event);
    this.#bus.publish(event);
    return event;
  }
}

async function executeWithAbort(execute: () => Promise<JsonValue> | JsonValue, signal: AbortSignal): Promise<JsonValue> {
  if (signal.aborted) {
    throw new Error("execution aborted before start");
  }

  return await new Promise<JsonValue>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => {
      settle(() => reject(new Error("execution aborted")));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(execute)
      .then((value) => settle(() => resolve(value)))
      .catch((error: unknown) => settle(() => reject(error)));
  });
}
