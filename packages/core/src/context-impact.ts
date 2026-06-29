import { redactStringWithSummary } from "./redaction.js";
import type {
  ContextImpactMetrics,
  ContextSavings,
  ContextSizeEstimate,
  ContextTokenEstimate,
  ContextWasteDelta
} from "./types.js";

const HEURISTIC_METHOD = "heuristic-chars-div-4" as const;
const HEURISTIC_PROVENANCE =
  "Provider token usage unavailable; estimated locally from character count divided by four.";

export interface ContextImpactInput {
  readonly rawContent: string;
  readonly modelFacingContent: string;
  readonly safeDisplayedContent?: string;
  readonly outputLimitBytes?: number;
  readonly fingerprint?: string;
  readonly repeatedFingerprintCount?: number;
}

export function estimateContextSize(content: string): ContextSizeEstimate {
  const chars = [...content].length;
  const bytes = Buffer.byteLength(content, "utf8");
  return { bytes, chars, estimatedTokens: estimateTokens(chars) };
}

export function heuristicTokenEstimate(content: string): ContextTokenEstimate {
  return {
    estimatedTokens: estimateContextSize(content).estimatedTokens,
    method: HEURISTIC_METHOD,
    provenance: HEURISTIC_PROVENANCE,
    confidence: "low"
  };
}

export function buildContextImpact(input: ContextImpactInput): ContextImpactMetrics {
  const safeDisplayed = input.safeDisplayedContent ?? input.modelFacingContent;
  const rawEstimate = estimateContextSize(input.rawContent);
  const modelFacing = estimateContextSize(input.modelFacingContent);
  const safeDisplayedEstimate = estimateContextSize(safeDisplayed);
  const redactedRaw = redactStringWithSummary(input.rawContent).value;
  const redactedRawEstimate = estimateContextSize(redactedRaw);
  const redactionSavings = positiveSavings(rawEstimate, redactedRawEstimate);
  const truncationSavings = positiveSavings(redactedRawEstimate, safeDisplayedEstimate);
  const floodSavings = positiveSavings(rawEstimate, safeDisplayedEstimate);
  const repeated = Math.max(1, Math.trunc(input.repeatedFingerprintCount ?? 1));
  const duplicateRepeats = Math.max(0, repeated - 1);
  const duplicateBytes = modelFacing.bytes * duplicateRepeats;
  const duplicateChars = modelFacing.chars * duplicateRepeats;

  return {
    modelFacingContent: modelFacing,
    rawContentEstimate: rawEstimate,
    safeDisplayedEstimate,
    tokenEstimate: heuristicTokenEstimate(input.modelFacingContent),
    preventedContextFlood: {
      rawEstimate,
      safeDisplayedEstimate,
      saved: floodSavings
    },
    redactionSavings,
    truncationSavings,
    duplicateRetryContext: {
      fingerprint: input.fingerprint ?? "not-repeated",
      repeatedFingerprintCount: repeated,
      estimatedDuplicateBytes: duplicateBytes,
      estimatedDuplicateChars: duplicateChars,
      estimatedDuplicateTokens: estimateTokens(duplicateChars)
    },
    retryAmplification: {
      attemptCount: repeated,
      contextMultiplier: repeated,
      estimatedAmplifiedBytes: modelFacing.bytes * repeated,
      estimatedAmplifiedTokens: modelFacing.estimatedTokens * repeated
    },
    notes: [
      "Exact byte and character counts are measured from model-facing safe content.",
      HEURISTIC_PROVENANCE,
      "Raw unsafe content is counted for estimates but not copied into model-facing fields."
    ]
  };
}

export function buildContextWasteDelta(input: {
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly notes?: readonly string[];
}): ContextWasteDelta {
  const before = estimateContextSize(input.beforeContent);
  const after = estimateContextSize(input.afterContent);
  return {
    before,
    after,
    delta: {
      bytes: after.bytes - before.bytes,
      chars: after.chars - before.chars,
      estimatedTokens: after.estimatedTokens - before.estimatedTokens
    },
    estimation: heuristicTokenEstimate(input.afterContent),
    notes: [
      "Policy simulation context deltas are dry-run estimates over recorded scenario summaries.",
      HEURISTIC_PROVENANCE,
      ...(input.notes ?? [])
    ]
  };
}

export function contextEstimationNotes(): {
  readonly tokenEstimateMethod: "heuristic-chars-div-4";
  readonly provenance: string;
  readonly confidence: "low";
  readonly notes: readonly string[];
} {
  return {
    tokenEstimateMethod: HEURISTIC_METHOD,
    provenance: HEURISTIC_PROVENANCE,
    confidence: "low",
    notes: [
      "Token counts are estimates, not provider billing data.",
      "Byte and character counts are exact for the strings ToolGuard makes model-facing.",
      "Raw artifacts stay separated; reports only include safe aggregate context metrics."
    ]
  };
}

function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

function positiveSavings(before: ContextSizeEstimate, after: ContextSizeEstimate): ContextSavings {
  return {
    bytes: Math.max(0, before.bytes - after.bytes),
    chars: Math.max(0, before.chars - after.chars),
    estimatedTokens: Math.max(0, before.estimatedTokens - after.estimatedTokens)
  };
}
