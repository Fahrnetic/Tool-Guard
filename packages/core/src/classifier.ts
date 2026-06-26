import type { FailureCard, FailureType, JsonValue, ToolCall } from "./types.js";

export class ClassifiedToolError extends Error {
  readonly failureType: FailureType;
  readonly rawDetails: readonly string[];

  constructor(failureType: FailureType, message: string, rawDetails: readonly string[] = [message]) {
    super(message);
    this.name = "ClassifiedToolError";
    this.failureType = failureType;
    this.rawDetails = rawDetails;
  }
}

export interface FailureClassification {
  readonly failureType: FailureType;
  readonly likelyRootCause: string;
  readonly retryable: boolean;
  readonly doNotRetrySameCall: boolean;
  readonly safeRecoveryOptions: readonly string[];
  readonly humanFix: string;
}

const RECOVERY: Record<FailureType, FailureClassification> = {
  unknown_tool: {
    failureType: "unknown_tool",
    likelyRootCause: "The requested tool is not registered with ToolGuard Core.",
    retryable: false,
    doNotRetrySameCall: true,
    safeRecoveryOptions: ["Select a registered tool name before retrying.", "Run preflight to inspect available tools."],
    humanFix: "Register the tool or correct the adapter's tool routing configuration."
  },
  invalid_arguments: {
    failureType: "invalid_arguments",
    likelyRootCause: "The tool arguments did not match the registered input schema.",
    retryable: false,
    doNotRetrySameCall: true,
    safeRecoveryOptions: ["Change the request arguments to match the schema.", "Inspect validation errors in evidence."],
    humanFix: "Fix the caller's argument construction or update the tool schema."
  },
  timeout: {
    failureType: "timeout",
    likelyRootCause: "The downstream tool did not complete before the configured deadline.",
    retryable: true,
    doNotRetrySameCall: false,
    safeRecoveryOptions: ["Retry only idempotent calls with a larger deadline.", "Check downstream fixture health first."],
    humanFix: "Increase the deadline for known slow tools or repair the downstream service."
  },
  cancellation: {
    failureType: "cancellation",
    likelyRootCause: "The call was cancelled before downstream execution completed.",
    retryable: true,
    doNotRetrySameCall: false,
    safeRecoveryOptions: ["Retry only if the caller still needs the result.", "Confirm no previous attempt is still running."],
    humanFix: "Inspect caller cancellation policy and downstream cleanup behavior."
  },
  cwd_mismatch: {
    failureType: "cwd_mismatch",
    likelyRootCause: "The downstream fixture was invoked from an unexpected working directory.",
    retryable: false,
    doNotRetrySameCall: true,
    safeRecoveryOptions: ["Use the fixture sandbox cwd.", "Run preflight before retrying the corrected call."],
    humanFix: "Set the adapter or process cwd to the fixture sandbox directory."
  },
  malformed_json: {
    failureType: "malformed_json",
    likelyRootCause: "The downstream fixture returned malformed JSON or an invalid protocol payload.",
    retryable: false,
    doNotRetrySameCall: true,
    safeRecoveryOptions: ["Repair the downstream protocol response before retrying.", "Inspect the raw payload artifact."],
    humanFix: "Fix the downstream serializer or adapter parser so it emits valid JSON."
  },
  process_crash: {
    failureType: "process_crash",
    likelyRootCause: "The downstream fixture crashed after initialization.",
    retryable: true,
    doNotRetrySameCall: false,
    safeRecoveryOptions: ["Retry after confirming the downstream process restarts cleanly.", "Run preflight again."],
    humanFix: "Inspect the crash artifact and repair the downstream initialization path."
  },
  prompt_injection_output: {
    failureType: "prompt_injection_output",
    likelyRootCause: "The downstream output contained instruction-like text that could manipulate an agent.",
    retryable: false,
    doNotRetrySameCall: true,
    safeRecoveryOptions: ["Treat the output as untrusted.", "Use a different recovery path or inspect raw evidence manually."],
    humanFix: "Sanitize or remove prompt-injection-like content at the downstream source."
  },
  secret_leak_risk: {
    failureType: "secret_leak_risk",
    likelyRootCause: "The downstream output resembled sensitive credential material.",
    retryable: false,
    doNotRetrySameCall: true,
    safeRecoveryOptions: ["Do not expose the output to agents.", "Rotate the secret if it is real."],
    humanFix: "Remove secret material from downstream output and review redaction policy."
  },
  destructive_action_blocked: {
    failureType: "destructive_action_blocked",
    likelyRootCause: "Policy blocked a potentially destructive action outside a fixture sandbox.",
    retryable: false,
    doNotRetrySameCall: true,
    safeRecoveryOptions: ["Use a fixture-only sandbox action.", "Choose a non-destructive operation."],
    humanFix: "Route demos to fixture-only tools or explicitly redesign the policy."
  },
  circuit_open: {
    failureType: "circuit_open",
    likelyRootCause: "The circuit breaker is open for this downstream target after repeated qualifying failures.",
    retryable: true,
    doNotRetrySameCall: true,
    safeRecoveryOptions: [
      "Wait for the circuit recovery window before probing again.",
      "Use an unrelated healthy target while this target recovers."
    ],
    humanFix: "Inspect recent failure artifacts, repair the affected downstream target, then allow a recovery probe."
  },
  policy_blocked: {
    failureType: "policy_blocked",
    likelyRootCause: "ToolGuard policy blocked the call before downstream execution.",
    retryable: false,
    doNotRetrySameCall: true,
    safeRecoveryOptions: ["Change the call to satisfy policy.", "Inspect the policy decision evidence."],
    humanFix: "Adjust policy only after confirming the call is safe."
  },
  unknown: {
    failureType: "unknown",
    likelyRootCause: "Tool execution failed without a more specific classified signal.",
    retryable: false,
    doNotRetrySameCall: true,
    safeRecoveryOptions: ["Inspect the raw artifact before retrying.", "Run preflight to narrow the failure."],
    humanFix: "Add a more specific classifier for this downstream failure mode."
  }
};

export function classifyFailure(input: {
  readonly error?: unknown;
  readonly failureType?: FailureType;
}): FailureClassification {
  const failureType =
    input.failureType ?? (input.error instanceof ClassifiedToolError ? input.error.failureType : "unknown");
  return RECOVERY[failureType] ?? RECOVERY.unknown;
}

export function getRawFailureDetails(error: unknown): readonly string[] {
  if (error instanceof ClassifiedToolError) {
    return error.rawDetails;
  }
  return [error instanceof Error ? error.message : String(error)];
}

export function detectSuspiciousOutput(value: JsonValue): FailureClassification | undefined {
  const serialized = JSON.stringify(value);
  if (
    /ignore\s+(all\s+)?previous\s+instructions/i.test(serialized) ||
    /reveal\s+(the\s+)?system\s+prompt/i.test(serialized) ||
    /developer\s+message/i.test(serialized)
  ) {
    return RECOVERY.prompt_injection_output;
  }

  if (
    /Bearer\s+[A-Za-z0-9._~+/-]{12,}/.test(serialized) ||
    /\bsk-[A-Za-z0-9_-]{20,}\b/.test(serialized) ||
    /\b(api[_-]?key|token|secret|password)\s*[:=]/i.test(serialized) ||
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(serialized)
  ) {
    return RECOVERY.secret_leak_risk;
  }

  return undefined;
}

export function buildFailureCard(input: {
  readonly call: ToolCall;
  readonly classification: FailureClassification;
  readonly evidenceLinks: FailureCard["evidenceLinks"];
  readonly safeSummarySuffix?: string;
}): FailureCard {
  return {
    toolName: input.call.toolName,
    failureType: input.classification.failureType,
    likelyRootCause: input.classification.likelyRootCause,
    retryable: input.classification.retryable,
    doNotRetrySameCall: input.classification.doNotRetrySameCall,
    safeRecoveryOptions: input.classification.safeRecoveryOptions,
    humanFix: input.classification.humanFix,
    evidenceLinks: input.evidenceLinks,
    safeSummary: `Tool ${input.call.toolName} failed with ${input.classification.failureType}. Raw details are stored separately in evidence artifacts.${
      input.safeSummarySuffix ? ` ${input.safeSummarySuffix}` : ""
    }`,
    rawDetailsSeparated: true
  };
}
