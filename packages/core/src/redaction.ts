import type { JsonObject, JsonValue } from "./types.js";

export interface RedactionResult {
  readonly value: string;
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
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = isSensitiveKey(key) ? "[REDACTED:sensitive-key]" : redactJsonValue(entry);
    }
    return redacted as JsonObject;
  }
  return value;
}

export function countRedactions(input: string): RedactionResult {
  return redactStringWithSummary(input);
}

function isSensitiveKey(key: string): boolean {
  return /^(api[_-]?key|token|secret|password|authorization)$/i.test(key);
}
