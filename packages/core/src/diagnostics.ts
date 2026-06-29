import { existsSync } from "node:fs";
import path from "node:path";
import { createId } from "./ids.js";
import { redactString, redactStringWithSummary } from "./redaction.js";
import type {
  DiagnosticEvidenceAnchor,
  DiagnosticFailureBoundary,
  DiagnosticFailureCause,
  DiagnosticHypothesis,
  EvidenceLink,
  FailureType,
  JsonValue,
  RootCauseConfidence,
  ToolCall
} from "./types.js";

export interface RootCauseDiagnostic {
  readonly failureCause: DiagnosticFailureCause;
  readonly failureBoundary: DiagnosticFailureBoundary;
  readonly failureMechanism: string;
  readonly rootCauseConfidence: RootCauseConfidence;
  readonly contributingFactors: readonly string[];
  readonly evidenceAnchors: readonly DiagnosticEvidenceAnchor[];
  readonly diagnosticHypotheses: readonly DiagnosticHypothesis[];
}

export function buildRootCauseDiagnostic(input: {
  readonly call: ToolCall;
  readonly failureType: FailureType;
  readonly rawDetails: readonly string[];
  readonly evidenceLinks: readonly EvidenceLink[];
}): RootCauseDiagnostic {
  const rawText = input.rawDetails.join("\n");
  const anchors: DiagnosticEvidenceAnchor[] = [];

  for (const link of input.evidenceLinks) {
    anchors.push(
      anchor("raw-artifact", "Raw artifact link", `Raw details are separated in ${link.label}.`, "medium", {
        artifactId: link.artifactId,
        href: link.href
      })
    );
  }

  anchors.push(
    anchor(
      "safe-environment",
      "Safe environment facts",
      `sourcePath=${input.call.sourcePath}; deadline=${input.call.deadlineMs ?? "none"}; cwdBasename=${path.basename(
        process.cwd()
      )}; packageManager=${detectPackageManagerContext()}`,
      "medium"
    )
  );

  const schemaAnchors = schemaValidationAnchors(input.rawDetails);
  anchors.push(...schemaAnchors);

  anchors.push(...redactedRawDetailAnchors(input.rawDetails));

  const parseAnchor = parseEvidenceAnchor(rawText);
  if (parseAnchor) {
    anchors.push(parseAnchor);
  }

  const cwdAnchors = cwdEvidenceAnchors(input.call, input.rawDetails);
  anchors.push(...cwdAnchors);

  const permissionAnchor = permissionEvidenceAnchor(input.call, rawText);
  if (permissionAnchor) {
    anchors.push(permissionAnchor);
  }

  const commandAnchor = commandResolutionAnchor(input.call, rawText);
  if (commandAnchor) {
    anchors.push(commandAnchor);
  }

  const timeoutAnchor = timeoutEvidenceAnchor(input.call, input.failureType, rawText);
  if (timeoutAnchor) {
    anchors.push(timeoutAnchor);
  }

  const primary = inferPrimary(input.failureType, rawText, anchors);
  const contributingFactors = buildContributingFactors(input.failureType, primary.cause, anchors);
  const diagnosticHypotheses = buildHypotheses(primary, anchors, input.failureType);

  return {
    failureCause: primary.cause,
    failureBoundary: primary.boundary,
    failureMechanism: primary.mechanism,
    rootCauseConfidence: primary.confidence,
    contributingFactors,
    evidenceAnchors: anchors,
    diagnosticHypotheses
  };
}

function inferPrimary(
  failureType: FailureType,
  rawText: string,
  anchors: readonly DiagnosticEvidenceAnchor[]
): {
  readonly cause: DiagnosticFailureCause;
  readonly boundary: DiagnosticFailureBoundary;
  readonly mechanism: string;
  readonly confidence: RootCauseConfidence;
} {
  if (failureType === "spawn_failure" || /\bENOENT\b|not found|command not found|executable/i.test(rawText)) {
    return {
      cause: "missing-binary",
      boundary: "environment",
      mechanism: "The executable resolution failed before downstream work could start.",
      confidence: "high"
    };
  }
  if (failureType === "cwd_mismatch") {
    return {
      cause: "wrong-cwd",
      boundary: "environment",
      mechanism: "The call ran from a working directory that did not match the downstream expectation.",
      confidence: "high"
    };
  }
  if (/EACCES|EPERM|permission denied/i.test(rawText)) {
    return {
      cause: /tmp|temp|fixture|sandbox/i.test(rawText) ? "permission-denied-temp" : "process-exit",
      boundary: "environment",
      mechanism: "Filesystem permissions prevented the attempted temp or sandbox operation.",
      confidence: "high"
    };
  }
  if (failureType === "invalid_arguments") {
    return {
      cause: "schema-mismatch",
      boundary: "caller",
      mechanism: "The caller supplied arguments that failed the registered JSON schema before execution.",
      confidence: anchors.some((anchor) => anchor.evidenceType === "schema-validation") ? "high" : "medium"
    };
  }
  if (failureType === "malformed_json" || /parse|JSON|frame|protocol/i.test(rawText)) {
    return {
      cause: "protocol-parse-failure",
      boundary: "protocol",
      mechanism: "The downstream payload could not be parsed into the expected protocol shape.",
      confidence: anchors.some((anchor) => anchor.evidenceType === "parse-offset") ? "high" : "medium"
    };
  }
  if (failureType === "timeout") {
    return {
      cause: anchors.some((anchor) => anchor.evidenceType === "timeout-source") ? "caller-deadline-timeout" : "downstream-hang-timeout",
      boundary: "caller",
      mechanism: "The caller deadline fired before the downstream tool produced a completed result.",
      confidence: anchors.some((anchor) => anchor.evidenceType === "timeout-source") ? "high" : "medium"
    };
  }
  if (failureType === "cancellation") {
    return {
      cause: "caller-cancellation",
      boundary: "caller",
      mechanism: "The caller cancellation signal aborted the in-flight tool call.",
      confidence: "high"
    };
  }
  if (failureType === "destructive_action_blocked" || failureType === "policy_blocked") {
    return {
      cause: "policy-block",
      boundary: "policy",
      mechanism: "ToolGuard policy stopped the call before downstream execution.",
      confidence: "high"
    };
  }
  if (failureType === "circuit_open") {
    return {
      cause: "circuit-open",
      boundary: "policy",
      mechanism: "The scoped circuit breaker is open after repeated qualifying failures.",
      confidence: "high"
    };
  }
  if (failureType === "prompt_injection_output") {
    return {
      cause: "suspicious-output",
      boundary: "safety",
      mechanism: "Downstream output contained instruction-like content and was contained as untrusted evidence.",
      confidence: "high"
    };
  }
  if (failureType === "secret_leak_risk") {
    return {
      cause: "secret-leak-risk",
      boundary: "safety",
      mechanism: "Downstream output matched credential-shaped patterns and was redacted from safe surfaces.",
      confidence: "high"
    };
  }
  if (failureType === "process_crash") {
    return {
      cause: "process-crash",
      boundary: "downstream",
      mechanism: "The downstream process failed after it began execution.",
      confidence: "medium"
    };
  }
  if (failureType === "sidecar_unavailable") {
    return {
      cause: "sidecar-unavailable",
      boundary: "adapter",
      mechanism: "The adapter could not reach the local ToolGuard sidecar endpoint.",
      confidence: "high"
    };
  }
  if (failureType === "sidecar_protocol_error") {
    return {
      cause: "sidecar-protocol",
      boundary: "protocol",
      mechanism: "The sidecar response did not match the expected versioned protocol.",
      confidence: "high"
    };
  }
  if (failureType === "output_limit_exceeded") {
    return {
      cause: "output-budget",
      boundary: "core",
      mechanism: "The result exceeded the model-facing output budget and was bounded.",
      confidence: "high"
    };
  }
  if (failureType === "non_zero_exit") {
    return {
      cause: "process-exit",
      boundary: "downstream",
      mechanism: "The wrapped process returned a non-zero exit status.",
      confidence: "medium"
    };
  }
  return {
    cause: "unknown",
    boundary: "unknown",
    mechanism: "ToolGuard did not find a stronger root-cause signal in the safe diagnostics.",
    confidence: "low"
  };
}

function buildHypotheses(
  primary: {
    readonly cause: DiagnosticFailureCause;
    readonly boundary: DiagnosticFailureBoundary;
    readonly mechanism: string;
    readonly confidence: RootCauseConfidence;
  },
  anchors: readonly DiagnosticEvidenceAnchor[],
  failureType: FailureType
): readonly DiagnosticHypothesis[] {
  const primaryAnchorIds = anchors
    .filter((anchor) => anchor.confidenceContribution === "high" || anchor.evidenceType !== "raw-artifact")
    .map((anchor) => anchor.anchorId);
  const hypotheses: DiagnosticHypothesis[] = [
    {
      rank: 1,
      cause: primary.cause,
      boundary: primary.boundary,
      mechanism: primary.mechanism,
      confidence: primary.confidence,
      evidenceAnchorIds: primaryAnchorIds
    }
  ];
  if (primary.confidence !== "high") {
    hypotheses.push({
      rank: 2,
      cause: fallbackCause(failureType),
      boundary: "downstream",
      mechanism: "A downstream-specific failure remains possible because the available evidence is indirect.",
      confidence: "low",
      evidenceAnchorIds: anchors.map((anchor) => anchor.anchorId)
    });
  }
  return hypotheses;
}

function fallbackCause(failureType: FailureType): DiagnosticFailureCause {
  if (failureType === "timeout") return "downstream-hang-timeout";
  if (failureType === "non_zero_exit") return "process-exit";
  if (failureType === "unknown") return "unknown";
  return "process-crash";
}

function buildContributingFactors(
  failureType: FailureType,
  cause: DiagnosticFailureCause,
  anchors: readonly DiagnosticEvidenceAnchor[]
): readonly string[] {
  const factors = new Set<string>();
  factors.add(`classified failure type: ${failureType}`);
  factors.add(`primary diagnostic cause: ${cause}`);
  if (anchors.some((anchor) => anchor.evidenceType === "cwd-fact")) {
    factors.add("working directory evidence was available");
  }
  if (anchors.some((anchor) => anchor.evidenceType === "schema-validation")) {
    factors.add("schema validation paths were available");
  }
  if (anchors.some((anchor) => anchor.evidenceType === "safe-environment")) {
    factors.add("safe environment facts were collected without env values");
  }
  return [...factors].map(redactString);
}

function schemaValidationAnchors(rawDetails: readonly string[]): readonly DiagnosticEvidenceAnchor[] {
  return rawDetails
    .map((detail) => {
      const match = /^(arguments(?:\.[A-Za-z0-9_-]+)*)\s+(?:must|is|was|should)\b/i.exec(detail);
      if (!match) return undefined;
      return anchor("schema-validation", "Schema validation path", detail, "high", { path: match[1] ?? "arguments" });
    })
    .filter((entry): entry is DiagnosticEvidenceAnchor => Boolean(entry));
}

function parseEvidenceAnchor(rawText: string): DiagnosticEvidenceAnchor | undefined {
  const offset = /(?:position|offset)\s*:?\s+(\d+)/i.exec(rawText);
  if (offset) {
    return anchor("parse-offset", "Protocol parse offset", `Parser reported offset ${offset[1]}.`, "high");
  }
  if (/parse|JSON|frame|protocol|content-length/i.test(rawText)) {
    return anchor("protocol-frame", "Protocol frame evidence", firstSafeLine(rawText), "medium");
  }
  return undefined;
}

function cwdEvidenceAnchors(call: ToolCall, rawDetails: readonly string[]): readonly DiagnosticEvidenceAnchor[] {
  const rawText = rawDetails.join("\n");
  const anchors: DiagnosticEvidenceAnchor[] = [];
  if (call.arguments.cwd || call.arguments.expectedCwd || /cwd|working directory/i.test(rawText)) {
    anchors.push(
      anchor(
        "cwd-fact",
        "Working directory evidence",
        `requestedCwd=${stringifySafe(call.arguments.cwd)}; expectedCwd=${stringifySafe(
          call.arguments.expectedCwd
        )}; actualCwdBasename=${path.basename(process.cwd())}`,
        "high"
      )
    );
    anchors.push(
      anchor(
        "package-context",
        "Package context",
        `packageManager=${detectPackageManagerContext()}; repoMarker=${detectRepoMarker()}`,
        "medium"
      )
    );
  }
  return anchors;
}

function permissionEvidenceAnchor(call: ToolCall, rawText: string): DiagnosticEvidenceAnchor | undefined {
  if (!/EACCES|EPERM|permission denied/i.test(rawText)) return undefined;
  return anchor(
    "permission-fact",
    "Permission evidence",
    `Permission error occurred in ${isTempLike(rawText, call.arguments.cwd) ? "temp-or-fixture scope" : "non-temp scope"}.`,
    "high"
  );
}

function commandResolutionAnchor(call: ToolCall, rawText: string): DiagnosticEvidenceAnchor | undefined {
  if (!/\bENOENT\b|not found|command not found|executable|spawn/i.test(rawText)) return undefined;
  const command = extractCommand(call.arguments) ?? extractSpawnCommand(rawText) ?? call.toolName;
  return anchor(
    "command-resolution",
    "Executable resolution evidence",
    `Command ${stringifySafe(command)} could not be resolved or launched. PATH values were intentionally not recorded.`,
    "high"
  );
}

function timeoutEvidenceAnchor(
  call: ToolCall,
  failureType: FailureType,
  rawText: string
): DiagnosticEvidenceAnchor | undefined {
  if (failureType !== "timeout" && !/deadline|timeout|timed out/i.test(rawText)) return undefined;
  return anchor(
    "timeout-source",
    "Timeout source",
    call.deadlineMs
      ? `Caller deadline of ${call.deadlineMs}ms fired before completion.`
      : "Timeout was observed, but no caller deadline value was recorded.",
    call.deadlineMs ? "high" : "medium"
  );
}

function redactedRawDetailAnchors(rawDetails: readonly string[]): readonly DiagnosticEvidenceAnchor[] {
  return rawDetails
    .map((detail) => {
      const redacted = redactStringWithSummary(detail);
      if (redacted.count === 0) return undefined;
      return anchor(
        "stderr-anchor",
        "Redacted diagnostic detail",
        `Diagnostic detail contained ${redacted.reasons.join(", ")} and was redacted: ${redacted.value}`,
        "medium"
      );
    })
    .filter((entry): entry is DiagnosticEvidenceAnchor => Boolean(entry));
}

function anchor(
  evidenceType: DiagnosticEvidenceAnchor["evidenceType"],
  label: string,
  summary: string,
  confidenceContribution: RootCauseConfidence,
  extras: Partial<Omit<DiagnosticEvidenceAnchor, "anchorId" | "evidenceType" | "label" | "summary" | "confidenceContribution">> = {}
): DiagnosticEvidenceAnchor {
  return {
    anchorId: createId("event"),
    evidenceType,
    label: redactString(label),
    summary: redactString(summary),
    confidenceContribution,
    ...extras
  };
}

function extractCommand(argumentsValue: ToolCall["arguments"]): string | undefined {
  const command = argumentsValue.command ?? argumentsValue.executable;
  if (typeof command === "string") return command;
  const argv = argumentsValue.argv;
  if (Array.isArray(argv) && typeof argv[0] === "string") return argv[0];
  return undefined;
}

function extractSpawnCommand(rawText: string): string | undefined {
  return /spawn\s+([^\s]+)\s+/i.exec(rawText)?.[1];
}

function firstSafeLine(rawText: string): string {
  return redactString(rawText.split(/\r?\n/).find((line) => line.trim()) ?? "Protocol parser reported a malformed frame.");
}

function stringifySafe(value: JsonValue | undefined): string {
  if (value === undefined) return "not-recorded";
  return redactString(typeof value === "string" ? value : JSON.stringify(value));
}

function isTempLike(rawText: string, cwd: JsonValue | undefined): boolean {
  return /\/tmp|\\tmp|temp|fixture|sandbox/i.test(rawText) || (typeof cwd === "string" && /\/tmp|\\tmp|temp|fixture|sandbox/i.test(cwd));
}

function detectPackageManagerContext(): string {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "package-lock.json"))) return "npm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "unknown";
}

function detectRepoMarker(): string {
  return existsSync(path.join(process.cwd(), ".git")) ? "git-worktree" : "none";
}
