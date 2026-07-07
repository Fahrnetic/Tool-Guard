import * as Sentry from "@sentry/node";
import { redactJsonValue, redactString } from "./redaction.js";
import type { JsonObject, JsonValue } from "./types.js";

export function initializeErrorTracking(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? "local",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.05)
  });
}

export function captureToolGuardError(error: unknown, context: JsonObject = {}): void {
  Sentry.captureException(error, {
    extra: redactJsonValue(context as JsonValue) as Record<string, unknown>,
    tags: { component: "toolguard-core" },
    level: "error",
    fingerprint: [redactString(error instanceof Error ? error.name : "unknown")]
  });
}
