import { EventBus, type CoreEvent, type CoreEventType } from "./events.js";
import { EvidenceRecorder } from "./evidence.js";
import { createId, type StableId } from "./ids.js";
import { exportStaticReport, type StaticReportResult } from "./report.js";
import type { ToolRegistry } from "./registry.js";
import { redactJsonValue } from "./redaction.js";
import {
  buildFailureCard,
  classifyFailure,
  detectSuspiciousOutput,
  getRawFailureDetails,
  type FailureClassification
} from "./classifier.js";
import type {
  EvidenceArtifact,
  EvidenceLink,
  FailureCard,
  FailureType,
  IntegrationVerificationReceipt,
  JsonValue,
  PolicyDecision,
  PolicySimulationResult,
  PreflightFinding,
  RegisteredTool,
  SideEffectLedgerEntry,
  ToolCall,
  ToolResult
} from "./types.js";
import {
  buildCallFingerprint,
  classifyRetryLoop,
  inferSideEffect,
  mergeFailureIntelligence,
  scoreBlastRadius,
  sideEffectSummary
} from "./side-effects.js";

export interface CoreSessionOptions {
  readonly evidenceRoot: string;
  readonly runId: StableId;
  readonly clock?: () => Date;
  readonly outputLimitBytes?: number;
  readonly retry?: {
    readonly maxRetries?: number;
  };
  readonly circuitBreaker?: {
    readonly failureThreshold?: number;
    readonly openMs?: number;
  };
}

interface CircuitState {
  readonly openedAtMs: number;
  readonly failureCount: number;
}

export class CoreSession {
  readonly #bus = new EventBus();
  readonly #recorder: EvidenceRecorder;
  readonly #clock: () => Date;
  readonly #runId: StableId;
  readonly #outputLimitBytes: number;
  readonly #maxRetries: number;
  readonly #circuitFailureThreshold: number;
  readonly #circuitOpenMs: number;
  readonly #circuit = new Map<string, CircuitState>();
  readonly #failures = new Map<string, number>();
  readonly #retryFingerprints = new Map<string, number>();
  #sequence = 0;

  constructor(options: CoreSessionOptions) {
    this.#runId = options.runId;
    this.#recorder = new EvidenceRecorder({
      rootDir: options.evidenceRoot,
      runId: options.runId
    });
    this.#clock = options.clock ?? (() => new Date());
    this.#outputLimitBytes = options.outputLimitBytes ?? 64 * 1024;
    this.#maxRetries = options.retry?.maxRetries ?? 1;
    this.#circuitFailureThreshold = options.circuitBreaker?.failureThreshold ?? 2;
    this.#circuitOpenMs = options.circuitBreaker?.openMs ?? 500;
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

  async emitAdapterConnected(
    context: {
      readonly runId: StableId;
      readonly traceId: StableId;
      readonly parentId?: StableId;
      readonly harnessId?: StableId;
      readonly adapterId?: StableId;
      readonly downstreamServerId?: StableId;
    },
    summary = "Adapter connected"
  ): Promise<CoreEvent> {
    return await this.#emitContext("adapter.connected", context, summary);
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
      const failure = await this.#recordFailure(call, "unknown_tool", [`Unknown tool: ${call.toolName}`]);
      await this.#emit("run.completed", call, "Run completed");
      return failure;
    }

    const validation = registry.validateCall(call);
    if (!validation.valid) {
      await this.#emit("server.preflight.completed", call, `Preflight failed: invalid arguments for ${call.toolName}`, {
        data: { status: "failed", reason: "invalid_arguments", errors: validation.errors as unknown as JsonValue }
      });
      const failure = await this.#recordFailure(call, "invalid_arguments", [...validation.errors]);
      await this.#emit("run.completed", call, "Run completed");
      return failure;
    }

    await this.#emit("server.preflight.completed", call, `Preflight completed: ${call.toolName}`, {
      data: { status: "healthy", reason: "registered_tool_and_arguments_valid" }
    });

    let attemptCall = call;
    let attemptIndex = 0;
    let startedAlready = true;
    while (true) {
      const result = await this.#executeAttempt(tool, attemptCall, options, startedAlready);
      startedAlready = false;
      if (!("failureType" in result)) {
        await this.#emit("run.completed", attemptCall, "Run completed");
        return result;
      }

      const targetKey = this.#targetKey(attemptCall);
      const shouldRetry = this.#shouldRetry(tool, attemptCall, result, attemptIndex);
      if (!shouldRetry.retry) {
        const finalFailure = shouldRetry.reason
          ? {
              ...result,
              safeSummary: `${result.safeSummary} ${shouldRetry.reason}`
            }
          : result;
        await this.#emit("run.completed", attemptCall, "Run completed");
        return finalFailure;
      }

      attemptIndex += 1;
      const nextCall = {
        ...call,
        attemptId: createId("attempt"),
        policyDecisionId: createId("policy")
      };
      await this.#emit("tool.retry.scheduled", nextCall, `Retry scheduled for ${call.toolName}`, {
        data: {
          policyDecisionId: nextCall.policyDecisionId,
          decision: "retry",
          reason: shouldRetry.reason ?? "Retry scheduled by bounded retry policy.",
          retryable: true,
          targetKey,
          nextAttemptId: nextCall.attemptId
        }
      });
      const fingerprint = buildCallFingerprint(attemptCall, result.failureType);
      const repeatedFailures = this.#retryFingerprints.get(fingerprint) ?? 1;
      await this.#recordSideEffect(nextCall, {
        tool,
        outcome: "retry",
        failureType: result.failureType,
        artifactIds: result.evidenceLinks.map((link) => link.artifactId),
        retryLoopFinding: classifyRetryLoop({ fingerprint, repeatedFailures, scheduledRetry: true })
      });
      attemptCall = nextCall;
    }
  }

  async failToolCall(
    call: ToolCall,
    failureTypeOrClassification: FailureCard["failureType"] | FailureClassification,
    rawDetails: readonly string[]
  ): Promise<FailureCard> {
    await this.#emit("run.started", call, "Run started");
    await this.#emit("tool.call.started", call, `Tool call started: ${call.toolName}`);
    const failure = await this.#recordFailure(call, failureTypeOrClassification, rawDetails);
    await this.#emit("run.completed", call, "Run completed");
    return failure;
  }

  async recordRawArtifact(
    call: ToolCall,
    input: {
      readonly kind: EvidenceArtifact["kind"];
      readonly fileName: string;
      readonly content: JsonValue | string;
      readonly redacted?: boolean;
    }
  ): Promise<EvidenceArtifact> {
    const artifact = await this.#recorder.writeArtifact({
      runId: call.runId,
      traceId: call.traceId,
      toolCallId: call.toolCallId,
      kind: input.kind,
      fileName: input.fileName,
      content: input.content,
      redacted: input.redacted ?? false
    });
    await this.#emitArtifactCreated(call, artifact);
    return artifact;
  }

  async emitOutputSanitized(
    call: ToolCall,
    summary: string,
    data: {
      readonly reason: string;
      readonly artifactId?: StableId;
      readonly outputLimitBytes?: number;
      readonly redactionCount?: number;
      readonly reasons?: string[];
      readonly streams?: string[];
    }
  ): Promise<CoreEvent> {
    return await this.#emit("output.sanitized", call, summary, {
      ...(data.artifactId ? { artifactId: data.artifactId } : {}),
      data: data as JsonValue as NonNullable<CoreEvent["data"]>
    });
  }

  async emitGeneratedArtifact(
    type: "topology.generated" | "narrative.generated",
    summary: string,
    data: JsonValue
  ): Promise<CoreEvent> {
    const last = this.#recorder.events.at(-1);
    const context = last
      ? {
          runId: last.runId,
          traceId: last.traceId,
          ...(last.parentId ? { parentId: last.parentId } : {}),
          ...(last.harnessId ? { harnessId: last.harnessId } : {}),
          ...(last.adapterId ? { adapterId: last.adapterId } : {}),
          ...(last.downstreamServerId ? { downstreamServerId: last.downstreamServerId } : {}),
          ...(last.toolCallId ? { toolCallId: last.toolCallId } : {}),
          ...(last.attemptId ? { attemptId: last.attemptId } : {}),
          ...(last.policyDecisionId ? { policyDecisionId: last.policyDecisionId } : {}),
          ...(last.artifactId ? { artifactId: last.artifactId } : {})
        }
      : { runId: this.#runId, traceId: createId("trace") };
    return await this.#emitContext(type, context, summary, { data: data as NonNullable<CoreEvent["data"]> });
  }

  async emitPolicySimulated(result: PolicySimulationResult): Promise<CoreEvent> {
    const artifactId = result.evidenceLinks[0]?.artifactId;
    return await this.#emitContext(
      "policy.simulated",
      { runId: result.runId, traceId: createId("trace") },
      `Policy simulated for ${result.scenarioId}`,
      artifactId ? { data: result, artifactId } : { data: result }
    );
  }

  async emitIntegrationVerified(receipt: IntegrationVerificationReceipt): Promise<CoreEvent> {
    const artifactId = receipt.evidenceLinks[0]?.artifactId;
    return await this.#emitContext(
      "integration.verified",
      { runId: receipt.runId, traceId: createId("trace") },
      `Integration verified for ${receipt.routeType}`,
      artifactId ? { data: receipt, artifactId } : { data: receipt }
    );
  }

  async #executeAttempt(
    tool: RegisteredTool,
    call: ToolCall,
    options: { readonly signal?: AbortSignal } = {},
    startedAlready = false
  ): Promise<ToolResult | FailureCard> {
    if (!startedAlready) {
      await this.#emit("tool.call.started", call, `Tool call started: ${call.toolName}`);
    }
    const targetKey = this.#targetKey(call);
    const circuitDecision = await this.#evaluateCircuit(call);
    if (circuitDecision.decision === "fail-fast") {
      await this.#emitPolicyDecision(call, circuitDecision);
      return await this.#recordFailure(call, "circuit_open", ["Circuit breaker is open for this downstream target."], [], tool);
    }

    const policy = this.#evaluatePolicy(tool, call);
    await this.#emitPolicyDecision(call, policy);
    if (policy.decision === "block") {
      return await this.#recordFailure(
        call,
        tool.destructiveRisk === "high" ? "destructive_action_blocked" : "policy_blocked",
        [policy.reason],
        [],
        tool
      );
    }

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

      const suspicious = detectSuspiciousOutput(rawOutput);
      if (suspicious) {
        await this.#emit("output.sanitized", call, `Suspicious output contained for ${call.toolName}`, {
          data: { reason: suspicious.failureType, artifactId: artifact.artifactId }
        });
        const failure = await this.#recordFailure(call, suspicious, ["Unsafe downstream output stored as raw evidence."], [
          artifact
        ], tool);
        await this.#recordTargetFailure(call, failure.failureType);
        return failure;
      }

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
      await this.#recordSideEffect(call, { tool, outcome: "completed", artifactIds: [artifact.artifactId] });
      await this.#recordTargetSuccess(call, targetKey);
      return result;
    } catch (error) {
      if (timeout) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", externalAbort);

      const failureType = controller.signal.aborted ? (abortReason ?? "cancellation") : "unknown";
      const failure = await this.#recordFailure(
        call,
        classifyFailure(controller.signal.aborted ? { error, failureType } : { error }),
        getRawFailureDetails(error),
        [],
        tool
      );
      await this.#recordTargetFailure(call, failure.failureType);
      return failure;
    }
  }

  async exportReport(): Promise<StaticReportResult> {
    const result = await exportStaticReport({ runDir: this.#recorder.runDir });
    const last = this.#recorder.events.at(-1);
    const context = last
      ? {
          runId: last.runId,
          traceId: last.traceId,
          ...(last.parentId ? { parentId: last.parentId } : {}),
          ...(last.harnessId ? { harnessId: last.harnessId } : {}),
          ...(last.adapterId ? { adapterId: last.adapterId } : {}),
          ...(last.downstreamServerId ? { downstreamServerId: last.downstreamServerId } : {}),
          ...(last.toolCallId ? { toolCallId: last.toolCallId } : {}),
          ...(last.attemptId ? { attemptId: last.attemptId } : {}),
          ...(last.policyDecisionId ? { policyDecisionId: last.policyDecisionId } : {})
        }
      : { runId: this.#runId, traceId: createId("trace") };
    await this.#emitContext("report.exported", context, "Static report exported", {
      data: {
        reportId: result.reportId,
        reportHtml: result.reportPath,
        manifestJson: result.manifestPath
      }
    });
    return result;
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
    await this.#recordSideEffect(call, { outcome: "completed", artifactIds: [artifact.artifactId] });
    await this.#emit("run.completed", call, "Run completed");

    return result;
  }

  async #recordFailure(
    call: ToolCall,
    failureTypeOrClassification: FailureCard["failureType"] | FailureClassification,
    rawDetails: readonly string[],
    existingArtifacts: readonly EvidenceArtifact[] = [],
    tool?: RegisteredTool
  ): Promise<FailureCard> {
    const classification =
      typeof failureTypeOrClassification === "string"
        ? classifyFailure({ failureType: failureTypeOrClassification })
        : failureTypeOrClassification;
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

    const links: EvidenceLink[] = [
      ...existingArtifacts.map((existing) => ({
        artifactId: existing.artifactId,
        href: existing.relativePath,
        label: `${existing.kind} artifact`
      })),
      {
        artifactId: artifact.artifactId,
        href: artifact.relativePath,
        label: "Raw failure artifact"
      }
    ];

    const baseFailure = buildFailureCard({ call, classification, evidenceLinks: links });
    const fingerprint = buildCallFingerprint(call, classification.failureType);
    const repeatedFailures = (this.#retryFingerprints.get(fingerprint) ?? 0) + 1;
    this.#retryFingerprints.set(fingerprint, repeatedFailures);
    const retryLoopFinding = classifyRetryLoop({ fingerprint, repeatedFailures, scheduledRetry: false });
    const ledgerEntry = await this.#recordSideEffect(call, {
      tool,
      outcome:
        classification.failureType === "destructive_action_blocked" ||
        classification.failureType === "policy_blocked" ||
        classification.failureType === "circuit_open"
          ? "blocked"
          : "failed",
      failureType: classification.failureType,
      artifactIds: links.map((link) => link.artifactId),
      retryLoopFinding
    });
    const failure = mergeFailureIntelligence(
      {
        ...baseFailure,
        safeSummary: `${baseFailure.safeSummary} Side effects: ${sideEffectSummary(ledgerEntry)}`
      },
      ledgerEntry,
      retryLoopFinding
    );

    if (retryLoopFinding.classification === "loop-detected") {
      await this.#emit("retry_loop.detected", call, `Retry loop detected for ${call.toolName}`, {
        data: retryLoopFinding
      });
    }

    await this.#emit("tool.call.failed", call, `Tool call failed: ${call.toolName}`, { data: failure });
    return failure;
  }

  async #recordSideEffect(
    call: ToolCall,
    input: {
      readonly tool?: RegisteredTool | undefined;
      readonly outcome: "completed" | "failed" | "blocked" | "retry";
      readonly failureType?: FailureType | undefined;
      readonly artifactIds: readonly StableId[];
      readonly retryLoopFinding?: ReturnType<typeof classifyRetryLoop>;
    }
  ): Promise<SideEffectLedgerEntry> {
    const sideEffect = inferSideEffect({
      tool: input.tool,
      call,
      failureType: input.failureType,
      outcome: input.outcome
    });
    const blastRadius = scoreBlastRadius({
      targetType: sideEffect.targetType,
      effectState: sideEffect.effectState,
      reversibility: sideEffect.reversibility,
      destructiveRisk: sideEffect.destructiveRisk,
      failureType: input.failureType
    });
    const entry: SideEffectLedgerEntry = {
      ledgerId: createId("ledger"),
      recordedAt: this.#clock().toISOString(),
      runId: call.runId,
      traceId: call.traceId,
      ...(call.parentId ? { parentId: call.parentId } : {}),
      harnessId: call.harnessId,
      adapterId: call.adapterId,
      downstreamServerId: call.downstreamServerId,
      toolCallId: call.toolCallId,
      attemptId: call.attemptId,
      policyDecisionId: call.policyDecisionId,
      artifactIds: input.artifactIds,
      toolName: call.toolName,
      targetType: sideEffect.targetType,
      effectState: sideEffect.effectState,
      reversibility: sideEffect.reversibility,
      operation: sideEffect.operation,
      summary: sideEffect.summary,
      blastRadius,
      ...(input.retryLoopFinding ? { retryLoopFinding: input.retryLoopFinding } : {})
    };
    await this.#recorder.appendLedgerEntry(entry);
    await this.#emit("side_effect.recorded", call, `Side effect recorded: ${entry.effectState}`, { data: entry });
    await this.#emit("blast_radius.scored", call, `Blast radius scored: ${blastRadius.score}`, { data: blastRadius });
    return entry;
  }

  #evaluatePolicy(tool: RegisteredTool, call: ToolCall): PolicyDecision {
    if (tool.destructiveRisk === "high" && call.arguments.fixtureOnly !== true) {
      return {
        policyDecisionId: call.policyDecisionId,
        decision: "block",
        reason: "Destructive actions are blocked unless explicitly fixture-only.",
        retryable: false
      };
    }
    return {
      policyDecisionId: call.policyDecisionId,
      decision: "allow",
      reason: "Registered tool and arguments satisfy safety policy.",
      retryable: true
    };
  }

  async #evaluateCircuit(call: ToolCall): Promise<PolicyDecision> {
    const targetKey = this.#targetKey(call);
    const state = this.#circuit.get(targetKey);
    if (!state) {
      return {
        policyDecisionId: call.policyDecisionId,
        decision: "allow",
        reason: "Circuit is closed for this downstream target.",
        retryable: true
      };
    }
    const elapsed = this.#clock().getTime() - state.openedAtMs;
    if (elapsed >= this.#circuitOpenMs) {
      return {
        policyDecisionId: call.policyDecisionId,
        decision: "allow",
        reason: "Circuit is half-open for a recovery probe.",
        retryable: true
      };
    }
    return {
      policyDecisionId: call.policyDecisionId,
      decision: "fail-fast",
      reason: "Circuit breaker is open for this downstream target.",
      retryable: false
    };
  }

  async #emitPolicyDecision(call: ToolCall, decision: PolicyDecision): Promise<void> {
    await this.#emit("policy.decision", call, `Policy decision: ${decision.decision}`, { data: decision });
  }

  #shouldRetry(
    tool: RegisteredTool,
    call: ToolCall,
    failure: FailureCard,
    attemptIndex: number
  ): { readonly retry: boolean; readonly reason?: string } {
    if (!failure.retryable || failure.doNotRetrySameCall) {
      return { retry: false };
    }
    if (attemptIndex >= this.#maxRetries) {
      return { retry: false, reason: "Retry policy reached the configured bounded retry limit." };
    }
    if (call.idempotency !== "idempotent" || tool.destructiveRisk === "medium" || tool.destructiveRisk === "high") {
      return {
        retry: false,
        reason: "Automatic retry was not retried because the call is non-idempotent, unsafe, or destructive."
      };
    }
    return { retry: true, reason: "Retryable failure on idempotent safe call within policy bounds." };
  }

  async #recordTargetFailure(call: ToolCall, failureType: FailureType): Promise<void> {
    if (!["timeout", "process_crash", "unknown"].includes(failureType)) {
      return;
    }
    const targetKey = this.#targetKey(call);
    const count = (this.#failures.get(targetKey) ?? 0) + 1;
    this.#failures.set(targetKey, count);
    if (count >= this.#circuitFailureThreshold && !this.#circuit.has(targetKey)) {
      this.#circuit.set(targetKey, { failureCount: count, openedAtMs: this.#clock().getTime() });
      await this.#emit("circuit.opened", call, `Circuit opened for ${targetKey}`, {
        data: {
          policyDecisionId: call.policyDecisionId,
          decision: "open-circuit",
          reason: `Opened after ${count} qualifying failures for ${targetKey}.`,
          retryable: false,
          targetKey
        }
      });
    }
  }

  async #recordTargetSuccess(call: ToolCall, targetKey: string): Promise<void> {
    this.#failures.set(targetKey, 0);
    if (this.#circuit.has(targetKey)) {
      this.#circuit.delete(targetKey);
      await this.#emit("circuit.closed", call, `Circuit closed for ${targetKey}`, {
        data: {
          policyDecisionId: call.policyDecisionId,
          decision: "close-circuit",
          reason: `Recovery probe succeeded for ${targetKey}.`,
          retryable: true,
          targetKey
        }
      });
    }
  }

  #targetKey(call: ToolCall): string {
    return `${call.downstreamServerId}:${call.toolName}`;
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
      ...(options.data
        ? { data: redactJsonValue(options.data as JsonValue) as NonNullable<CoreEvent["data"]> }
        : {})
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
      ...(options.data
        ? { data: redactJsonValue(options.data as JsonValue) as NonNullable<CoreEvent["data"]> }
        : {})
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
