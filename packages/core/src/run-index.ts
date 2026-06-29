import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CoreEvent } from "./events.js";
import { redactString } from "./redaction.js";
import type { FailureCard, JsonValue, ToolCall } from "./types.js";

export type RunIndexRouteType = "direct" | "cli" | "mcp" | "python";
export type RunIndexStatus = "running" | "succeeded" | "failed";

export interface SafeRunLabels {
  readonly session?: string;
  readonly task?: string;
  readonly repo?: string;
  readonly agent?: string;
}

export interface RunIndexSeed {
  readonly runIndexRecordId: string;
  readonly runName: string;
  readonly routeType: RunIndexRouteType;
  readonly sourcePath: ToolCall["sourcePath"];
  readonly hostHarness: {
    readonly id: string;
    readonly name: string;
  };
  readonly adapter: {
    readonly id: string;
    readonly name: string;
  };
  readonly downstreamTarget: {
    readonly id: string;
    readonly toolName: string;
    readonly originalToolName?: string;
  };
  readonly command?: string;
  readonly tool: string;
  readonly evidencePath: string;
  readonly eventsPath: string;
  readonly tags: readonly string[];
  readonly labels: SafeRunLabels;
}

export interface RunIndexRecord extends RunIndexSeed {
  readonly runId: string;
  readonly status: RunIndexStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly firstFailure?: {
    readonly failureType: string;
    readonly summary: string;
  };
}

export class RunIndexStore {
  readonly #indexPath: string;
  readonly #records = new Map<string, RunIndexRecord>();
  #loaded = false;

  constructor(rootDir: string) {
    this.#indexPath = path.join(rootDir, "run-index.jsonl");
  }

  get indexPath(): string {
    return this.#indexPath;
  }

  async listRecords(): Promise<readonly RunIndexRecord[]> {
    await this.#load();
    return [...this.#records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async ingestEvent(event: CoreEvent): Promise<void> {
    await this.#load();
    const seed = runIndexSeedFromEvent(event);
    const recordId = seed?.runIndexRecordId ?? runIndexRecordIdFromEvent(event);
    const existing = this.#records.get(recordId);
    if (event.type === "run.started" || seed) {
      const startedAt = existing?.startedAt ?? event.occurredAt;
      this.#records.set(recordId, {
        ...(existing ?? defaultRecordFromEvent(event)),
        ...(seed ?? {}),
        runIndexRecordId: recordId,
        runId: event.runId,
        startedAt,
        status: existing?.status ?? "running"
      });
      await this.#persist();
      return;
    }

    if (!existing) {
      return;
    }

    if (event.type === "tool.call.failed") {
      const firstFailure = existing.firstFailure ?? firstFailureFromEvent(event);
      this.#records.set(recordId, {
        ...existing,
        status: "failed",
        ...(firstFailure ? { firstFailure } : {})
      });
      await this.#persist();
      return;
    }

    if (event.type === "tool.call.completed") {
      this.#records.set(recordId, {
        ...existing,
        status: existing.status === "failed" ? "failed" : "succeeded"
      });
      await this.#persist();
      return;
    }

    if (event.type === "run.completed") {
      this.#records.set(recordId, {
        ...existing,
        status: existing.status === "failed" ? "failed" : "succeeded",
        completedAt: event.occurredAt
      });
      await this.#persist();
    }
  }

  async #load(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;
    try {
      const content = await readFile(this.#indexPath, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        const parsed = JSON.parse(line) as RunIndexRecord;
        if (typeof parsed.runId === "string" && typeof parsed.startedAt === "string") {
          const runIndexRecordId =
            typeof parsed.runIndexRecordId === "string" ? parsed.runIndexRecordId : legacyRunIndexRecordId(parsed);
          this.#records.set(runIndexRecordId, { ...parsed, runIndexRecordId });
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async #persist(): Promise<void> {
    await mkdir(path.dirname(this.#indexPath), { recursive: true });
    const lines = [...this.#records.values()]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((record) => JSON.stringify(record));
    await writeFile(this.#indexPath, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
  }
}

export function buildRunIndexSeed(call: ToolCall, evidencePath: string, eventsPath: string): RunIndexSeed {
  const routeType = routeTypeFor(call.sourcePath);
  const command = commandFromCall(call);
  const labels = sanitizeLabels(call.labels);
  const tags = sanitizeTags(call.tags);
  return {
    runIndexRecordId: runIndexRecordIdFromCall(call),
    runName: sanitizeLabel(call.runName ?? defaultRunName(routeType, command ?? call.originalToolName ?? call.toolName)),
    routeType,
    sourcePath: call.sourcePath,
    hostHarness: {
      id: sanitizeLabel(call.harnessId),
      name: sanitizeLabel(call.harnessName ?? defaultHarnessName(routeType))
    },
    adapter: {
      id: sanitizeLabel(call.adapterId),
      name: sanitizeLabel(call.adapterName ?? defaultAdapterName(routeType))
    },
    downstreamTarget: {
      id: sanitizeLabel(call.downstreamServerId),
      toolName: sanitizeLabel(call.toolName),
      ...(call.originalToolName ? { originalToolName: sanitizeLabel(call.originalToolName) } : {})
    },
    ...(command ? { command } : {}),
    tool: sanitizeLabel(call.originalToolName ?? call.toolName),
    evidencePath: sanitizeLabel(evidencePath),
    eventsPath: sanitizeLabel(eventsPath),
    tags,
    labels
  };
}

function routeTypeFor(sourcePath: ToolCall["sourcePath"]): RunIndexRouteType {
  switch (sourcePath) {
    case "cli-wrapper":
      return "cli";
    case "mcp-adapter":
      return "mcp";
    case "framework-adapter":
      return "python";
    case "non-mcp-direct":
      return "direct";
  }
}

function commandFromCall(call: ToolCall): string | undefined {
  const command = call.arguments.command;
  if (Array.isArray(command)) {
    return sanitizeLabel(command.map((part) => String(part)).join(" "));
  }
  if (typeof command === "string") {
    return sanitizeLabel(command);
  }
  return undefined;
}

function defaultRunName(routeType: RunIndexRouteType, target: string): string {
  return `${routeType} ${target}`;
}

function defaultHarnessName(routeType: RunIndexRouteType): string {
  return routeType === "python" ? "python-framework" : routeType;
}

function defaultAdapterName(routeType: RunIndexRouteType): string {
  switch (routeType) {
    case "cli":
      return "toolguard-cli-wrapper";
    case "mcp":
      return "toolguard-mcp-adapter";
    case "python":
      return "toolguard-python-adapter";
    case "direct":
      return "toolguard-core";
  }
}

function runIndexSeedFromEvent(event: CoreEvent): RunIndexSeed | undefined {
  const data = event.data;
  if (isRecord(data) && isRecord(data.runIndex)) {
    return data.runIndex as unknown as RunIndexSeed;
  }
  return undefined;
}

function defaultRecordFromEvent(event: CoreEvent): RunIndexRecord {
  return {
    runIndexRecordId: runIndexRecordIdFromEvent(event),
    runId: event.runId,
    runName: "unknown run",
    routeType: "direct",
    sourcePath: "non-mcp-direct",
    hostHarness: { id: sanitizeLabel(event.harnessId ?? "unknown"), name: "unknown" },
    adapter: { id: sanitizeLabel(event.adapterId ?? "unknown"), name: "unknown" },
    downstreamTarget: {
      id: sanitizeLabel(event.downstreamServerId ?? "unknown"),
      toolName: sanitizeLabel(event.toolCallId ?? "unknown")
    },
    tool: sanitizeLabel(event.toolCallId ?? "unknown"),
    status: "running",
    startedAt: event.occurredAt,
    evidencePath: "",
    eventsPath: "",
    tags: [],
    labels: {}
  };
}

function runIndexRecordIdFromCall(call: ToolCall): string {
  return sanitizeLabel(`${call.runId}:${call.toolCallId}`);
}

function runIndexRecordIdFromEvent(event: CoreEvent): string {
  return sanitizeLabel(`${event.runId}:${event.toolCallId ?? "run"}`);
}

function legacyRunIndexRecordId(record: Pick<RunIndexRecord, "runId"> & { readonly toolCallId?: string }): string {
  return sanitizeLabel(`${record.runId}:${record.toolCallId ?? "run"}`);
}

function firstFailureFromEvent(event: CoreEvent): RunIndexRecord["firstFailure"] {
  const data = event.data;
  if (isFailureCard(data)) {
    return {
      failureType: sanitizeLabel(data.failureType),
      summary: sanitizeLabel(data.safeSummary)
    };
  }
  return {
    failureType: "unknown",
    summary: sanitizeLabel(event.summary)
  };
}

function isFailureCard(value: CoreEvent["data"]): value is FailureCard {
  return isRecord(value) && typeof value.failureType === "string" && typeof value.safeSummary === "string";
}

function sanitizeLabels(labels: ToolCall["labels"]): SafeRunLabels {
  return {
    ...(labels?.session ? { session: sanitizeLabel(labels.session) } : {}),
    ...(labels?.task ? { task: sanitizeLabel(labels.task) } : {}),
    ...(labels?.repo ? { repo: sanitizeLabel(labels.repo) } : {}),
    ...(labels?.agent ? { agent: sanitizeLabel(labels.agent) } : {})
  };
}

function sanitizeTags(tags: ToolCall["tags"]): readonly string[] {
  return [...new Set((tags ?? []).map(sanitizeLabel).filter(Boolean))].slice(0, 16);
}

function sanitizeLabel(value: string): string {
  return redactString(String(value)).slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, JsonValue | unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
