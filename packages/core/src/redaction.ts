import type { JsonObject, JsonValue } from "./types.js";

export interface RedactionResult {
  readonly value: string;
  readonly count: number;
  readonly reasons: readonly string[];
}

export interface JsonRedactionResult {
  readonly value: JsonValue;
  readonly count: number;
  readonly reasons: readonly string[];
}

const REDACTIONS: readonly { readonly reason: string; readonly pattern: RegExp }[] = [
  { reason: "bearer-token", pattern: /Bearer\s+[A-Za-z0-9._~+/-]{12,}/g },
  { reason: "openai-style-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { reason: "api-key-assignment", pattern: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}["']?/gi },
  {
    reason: "pem-private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  { reason: "token-shaped-value", pattern: /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g }
];

export function redactString(input: string): string {
  return redactStringWithSummary(input).value;
}

export function redactStringWithSummary(input: string): RedactionResult {
  let value = input;
  let count = 0;
  const reasons = new Set<string>();
  for (const redaction of REDACTIONS) {
    value = value.replace(redaction.pattern, (match) => {
      count += 1;
      reasons.add(redaction.reason);
      return `[REDACTED:${redaction.reason}:${match.length}]`;
    });
  }
  return { value, count, reasons: [...reasons] };
}

export function redactJsonValue(value: JsonValue): JsonValue {
  return redactJsonValueWithSummary(value).value;
}

export function redactJsonValueWithSummary(value: JsonValue): JsonRedactionResult {
  if (typeof value === "string") {
    return redactStringWithSummary(value);
  }
  if (Array.isArray(value)) {
    const entries = value.map((entry) => redactJsonValueWithSummary(entry));
    return {
      value: entries.map((entry) => entry.value),
      count: entries.reduce((sum, entry) => sum + entry.count, 0),
      reasons: mergeReasons(entries)
    };
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, JsonValue> = {};
    let count = 0;
    const reasons = new Set<string>();
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        redacted[key] = "[REDACTED:sensitive-key]";
        count += 1;
        reasons.add("sensitive-key");
        continue;
      }
      const redactedEntry = redactJsonValueWithSummary(entry);
      redacted[key] = redactedEntry.value;
      count += redactedEntry.count;
      for (const reason of redactedEntry.reasons) {
        reasons.add(reason);
      }
    }
    return { value: redacted as JsonObject, count, reasons: [...reasons] };
  }
  return { value, count: 0, reasons: [] };
}

export function countRedactions(input: string): RedactionResult {
  return redactStringWithSummary(input);
}

function isSensitiveKey(key: string): boolean {
  return /^(api[_-]?key|token|secret|password|authorization)$/i.test(key);
}

function mergeReasons(results: readonly { readonly reasons: readonly string[] }[]): readonly string[] {
  const reasons = new Set<string>();
  for (const result of results) {
    for (const reason of result.reasons) {
      reasons.add(reason);
    }
  }
  return [...reasons];
}
