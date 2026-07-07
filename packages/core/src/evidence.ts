import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId, type StableId } from "./ids.js";
import type { CoreEvent } from "./events.js";
import type { EvidenceArtifact, JsonValue, SideEffectLedgerEntry } from "./types.js";
import { RunIndexStore, type RunIndexRecord } from "./run-index.js";

export interface EvidenceRecorderOptions {
  readonly rootDir: string;
  readonly runId: StableId;
}

export class EvidenceRecorder {
  readonly #runDir: string;
  readonly #runIndex: RunIndexStore;
  readonly #events: CoreEvent[] = [];
  readonly #ledger: SideEffectLedgerEntry[] = [];
  #runIndexWrites: Promise<void> = Promise.resolve();

  constructor(options: EvidenceRecorderOptions) {
    this.#runDir = path.join(options.rootDir, options.runId);
    this.#runIndex = new RunIndexStore(options.rootDir);
  }

  get runDir(): string {
    return this.#runDir;
  }

  get eventsPath(): string {
    return path.join(this.#runDir, "events.jsonl");
  }

  get events(): readonly CoreEvent[] {
    return this.#events;
  }

  get runIndexPath(): string {
    return this.#runIndex.indexPath;
  }

  get coverageHistoryPath(): string {
    return path.join(path.dirname(this.#runDir), "coverage-history.jsonl");
  }

  async listCoverageHistoryEvents(): Promise<readonly CoreEvent[]> {
    try {
      const content = await readFile(this.coverageHistoryPath, "utf8");
      const byEventId = new Map<string, CoreEvent>();
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as CoreEvent;
          if (isCoverageHistoryEvent(parsed) && typeof parsed.eventId === "string") {
            byEventId.set(parsed.eventId, parsed);
          }
        } catch {
          // Ignore malformed history lines; validators exercise normal write paths.
        }
      }
      return [...byEventId.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async listRunIndexRecords(): Promise<readonly RunIndexRecord[]> {
    await this.flushRunIndex();
    return await this.#runIndex.listRecords();
  }

  async flushRunIndex(): Promise<void> {
    await this.#runIndexWrites;
  }

  get ledgerPath(): string {
    return path.join(this.#runDir, "ledger.jsonl");
  }

  get ledger(): readonly SideEffectLedgerEntry[] {
    return this.#ledger;
  }

  async appendEvent(event: CoreEvent): Promise<void> {
    await mkdir(this.#runDir, { recursive: true });
    this.#events.push(event);
    const jsonl = `${this.#events.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(this.eventsPath, jsonl, "utf8");
    this.#runIndexWrites = this.#runIndexWrites.then(() => this.#runIndex.ingestEvent(event));
    if (isCoverageHistoryEvent(event)) {
      await this.#appendCoverageHistoryEvent(event);
    }
  }

  async #appendCoverageHistoryEvent(event: CoreEvent): Promise<void> {
    await mkdir(path.dirname(this.coverageHistoryPath), { recursive: true });
    const existing = await this.listCoverageHistoryEvents();
    const byEventId = new Map(existing.map((entry) => [entry.eventId, entry]));
    byEventId.set(event.eventId, event);
    const jsonl = `${[...byEventId.values()].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(this.coverageHistoryPath, jsonl, "utf8");
  }

  async appendLedgerEntry(entry: SideEffectLedgerEntry): Promise<void> {
    await mkdir(this.#runDir, { recursive: true });
    this.#ledger.push(entry);
    const jsonl = `${this.#ledger.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await writeFile(this.ledgerPath, jsonl, "utf8");
  }

  async writeArtifact(input: {
    readonly runId: StableId;
    readonly traceId: StableId;
    readonly toolCallId?: StableId;
    readonly kind: EvidenceArtifact["kind"];
    readonly fileName: string;
    readonly content: JsonValue | string;
    readonly redacted: boolean;
  }): Promise<EvidenceArtifact> {
    const artifactId = createId("artifact");
    const artifactDir = path.join(this.#runDir, "artifacts");
    await mkdir(artifactDir, { recursive: true });

    const serialized = typeof input.content === "string" ? input.content : `${JSON.stringify(input.content, null, 2)}\n`;
    const relativePath = path.join("artifacts", input.fileName);
    await writeFile(path.join(this.#runDir, relativePath), serialized, "utf8");

    return {
      artifactId,
      runId: input.runId,
      traceId: input.traceId,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      kind: input.kind,
      relativePath,
      sha256: createHash("sha256").update(serialized).digest("hex"),
      byteLength: Buffer.byteLength(serialized, "utf8"),
      redacted: input.redacted
    };
  }
}

function isCoverageHistoryEvent(event: CoreEvent): boolean {
  return event.type === "integration.verified" || typeof event.visibility?.routeType === "string";
}
