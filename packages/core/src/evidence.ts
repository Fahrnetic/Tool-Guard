import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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

    const serialized =
      typeof input.content === "string" ? input.content : `${JSON.stringify(input.content, null, 2)}\n`;
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
