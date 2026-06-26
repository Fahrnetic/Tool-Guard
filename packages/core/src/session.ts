import { EventBus, type CoreEvent, type CoreEventType } from "./events.js";
import { EvidenceRecorder } from "./evidence.js";
import { createId, type StableId } from "./ids.js";
import type { JsonValue, ToolCall, ToolResult } from "./types.js";

export interface CoreSessionOptions {
  readonly evidenceRoot: string;
  readonly runId: StableId;
  readonly clock?: () => Date;
}

export class CoreSession {
  readonly #bus = new EventBus();
  readonly #recorder: EvidenceRecorder;
  readonly #clock: () => Date;
  #sequence = 0;

  constructor(options: CoreSessionOptions) {
    this.#recorder = new EvidenceRecorder({
      rootDir: options.evidenceRoot,
      runId: options.runId
    });
    this.#clock = options.clock ?? (() => new Date());
  }

  get bus(): EventBus {
    return this.#bus;
  }

  get recorder(): EvidenceRecorder {
    return this.#recorder;
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

    await this.#emit("evidence.artifact.created", call, `Evidence artifact created: ${artifact.artifactId}`, {
      data: artifact,
      artifactId: artifact.artifactId
    });

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
}
