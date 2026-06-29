import type { StableId } from "./ids.js";
import type {
  BlastRadiusResult,
  EvidenceArtifact,
  FailureCard,
  JsonObject,
  PolicyDecision,
  RetryLoopFinding,
  SideEffectLedgerEntry,
  ToolResult
} from "./types.js";

export type CoreEventType =
  | "run.started"
  | "run.completed"
  | "adapter.connected"
  | "server.preflight.started"
  | "server.preflight.completed"
  | "policy.decision"
  | "tool.call.started"
  | "tool.call.completed"
  | "tool.call.failed"
  | "tool.retry.scheduled"
  | "side_effect.recorded"
  | "blast_radius.scored"
  | "retry_loop.detected"
  | "circuit.opened"
  | "circuit.closed"
  | "output.sanitized"
  | "evidence.artifact.created"
  | "report.exported";

export interface CorrelationFields {
  readonly runId: StableId;
  readonly traceId: StableId;
  readonly parentId?: StableId;
  readonly harnessId?: StableId;
  readonly adapterId?: StableId;
  readonly downstreamServerId?: StableId;
  readonly toolCallId?: StableId;
  readonly attemptId?: StableId;
  readonly policyDecisionId?: StableId;
  readonly artifactId?: StableId;
}

export interface CoreEvent extends CorrelationFields {
  readonly eventId: StableId;
  readonly type: CoreEventType;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly summary: string;
  readonly data?:
    | JsonObject
    | ToolResult
    | FailureCard
    | EvidenceArtifact
    | PolicyDecision
    | SideEffectLedgerEntry
    | BlastRadiusResult
    | RetryLoopFinding;
}

export type EventListener = (event: CoreEvent) => void;

export class EventBus {
  readonly #listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(event: CoreEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
