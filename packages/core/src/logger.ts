import { redactJsonValue, redactString } from "./redaction.js";
import type { JsonObject, JsonValue } from "./types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly time: string;
  readonly context: JsonObject;
}

export function createStructuredLogEntry(level: LogLevel, message: string, context: JsonObject = {}): StructuredLogEntry {
  return {
    level,
    message: redactString(message),
    time: new Date().toISOString(),
    context: redactJsonValue(context as JsonValue) as JsonObject
  };
}

export function writeStructuredLog(entry: StructuredLogEntry, output: Pick<Console, "log" | "error" | "warn"> = console): void {
  const line = JSON.stringify(entry);
  if (entry.level === "error") {
    output.error(line);
  } else if (entry.level === "warn") {
    output.warn(line);
  } else {
    output.log(line);
  }
}
