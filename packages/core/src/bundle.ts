import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CoreSession } from "./session.js";
import { validateReportManifest, type ManifestValidationResult } from "./report.js";
import { generateAndPersistNarrative, generateAndPersistTopology } from "./topology.js";
import type {
  EvidenceArtifact,
  IntegrationVerificationReceipt,
  JsonObject,
  PolicySimulationResult,
  RetryLoopFinding,
  SideEffectLedgerEntry
} from "./types.js";

export interface EvidenceBundleReplaySafety {
  readonly fixtureOnly?: boolean;
  readonly safeLoopback?: boolean;
}

export interface EvidenceBundleArtifactHash {
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface EvidenceBundleManifest {
  readonly bundleId: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly files: {
    readonly reportHtml: string;
    readonly eventsJsonl: string;
    readonly topologyJson: string;
    readonly ledgerJsonl: string;
    readonly narrativeJson: string;
    readonly blastRadiusJson: string;
    readonly retryLoopsJson: string;
    readonly policySimulatorResultJson: string;
    readonly integrationVerificationReceiptsJson: string;
    readonly artifactHashesJson: string;
    readonly manifestValidationJson: string;
    readonly redactionSummaryJson: string;
    readonly replayInstructionsJson?: string;
  };
  readonly rawArtifacts: readonly string[];
  readonly artifactHashes: readonly EvidenceBundleArtifactHash[];
  readonly reportManifestValidation: ManifestValidationResult;
  readonly manifestValidation: ManifestValidationResult;
  readonly redaction: {
    readonly summaryFile: string;
  };
  readonly replay: {
    readonly safe: boolean;
    readonly reason: string;
    readonly instructionsFile?: string;
  };
}

export interface EvidenceBundleResult {
  readonly bundleId: string;
  readonly bundleDir: string;
  readonly manifestPath: string;
  readonly validationPath: string;
  readonly manifest: EvidenceBundleManifest;
  readonly validation: ManifestValidationResult;
}

export async function exportEvidenceBundle(input: {
  readonly session: CoreSession;
  readonly replaySafety?: EvidenceBundleReplaySafety;
}): Promise<EvidenceBundleResult> {
  const session = input.session;
  const runDir = session.recorder.runDir;
  const bundleDir = path.join(runDir, "bundle");
  const evidenceDir = path.join(bundleDir, "evidence");
  const rawDir = path.join(evidenceDir, "raw-untrusted");
  await mkdir(rawDir, { recursive: true });

  const report = await session.exportReport();
  const reportManifestValidation = await validateReportManifest({ runDir });
  const topology = await generateAndPersistTopology({
    runId: session.runId,
    runDir,
    events: session.recorder.events,
    ledger: session.recorder.ledger
  });
  await generateAndPersistNarrative({
    runId: session.runId,
    runDir,
    events: session.recorder.events,
    ledger: session.recorder.ledger,
    topology
  });

  await copyFile(report.reportPath, path.join(bundleDir, "report.html"));
  await copyFile(path.join(runDir, "topology.json"), path.join(bundleDir, "topology.json"));
  await copyFile(path.join(runDir, "narrative.json"), path.join(bundleDir, "narrative.json"));
  await copyOptionalFile(session.recorder.ledgerPath, path.join(bundleDir, "ledger.jsonl"), "");
  await copyOptionalFile(report.redactionSummaryPath, path.join(bundleDir, "redaction-summary.json"), "{}\n");

  const policies = extractEventData<PolicySimulationResult>(session.recorder.events, "policy.simulated");
  const receipts = extractEventData<IntegrationVerificationReceipt>(session.recorder.events, "integration.verified");
  await writeFile(path.join(bundleDir, "policy-simulator-result.json"), `${stableStringify({ results: policies })}\n`, "utf8");
  await writeFile(
    path.join(bundleDir, "integration-verification-receipts.json"),
    `${stableStringify({ receipts })}\n`,
    "utf8"
  );
  await writeFile(path.join(bundleDir, "blast-radius.json"), `${stableStringify(buildBlastRadius(session.recorder.ledger))}\n`, "utf8");
  await writeFile(path.join(bundleDir, "retry-loops.json"), `${stableStringify(buildRetryLoops(session.recorder.ledger))}\n`, "utf8");

  const artifactCopies = await copyEvidenceArtifacts(
    runDir,
    session.recorder.events.map((event) => event.data).filter(isEvidenceArtifact),
    evidenceDir
  );
  await writeFile(
    path.join(rawDir, "README.txt"),
    "Files in this directory are raw/untrusted downstream evidence. Do not paste them into an agent context without ToolGuard redaction or review.\n",
    "utf8"
  );

  const replay = replayDecision(input.replaySafety, session.recorder.ledger);
  if (replay.safe) {
    await writeFile(path.join(bundleDir, "replay-instructions.json"), `${stableStringify(buildReplayInstructions(session.runId, replay.reason))}\n`, "utf8");
  }

  await session.emitBundleExported({
    bundleDir,
    replaySafe: replay.safe,
    policySimulatorResults: policies.length,
    verificationReceipts: receipts.length,
    rawArtifactFiles: artifactCopies.rawRelativePaths.length
  });

  await copyFile(session.recorder.eventsPath, path.join(bundleDir, "events.jsonl"));
  const validationPath = path.join(bundleDir, "manifest-validation.json");
  const provisionalValidation: ManifestValidationResult = { valid: true, errors: [] };
  await writeFile(validationPath, `${JSON.stringify(provisionalValidation, null, 2)}\n`, "utf8");

  const artifactHashes = await hashBundleFiles(bundleDir);
  await writeFile(path.join(bundleDir, "artifact-hashes.json"), `${JSON.stringify(artifactHashes, null, 2)}\n`, "utf8");

  const bundleId = `bundle-${createHash("sha256").update(`${session.runId}:${bundleDir}`).digest("hex").slice(0, 12)}`;
  const manifestWithoutValidation = {
    bundleId,
    runId: session.runId,
    generatedAt: new Date().toISOString(),
    files: {
      reportHtml: "report.html",
      eventsJsonl: "events.jsonl",
      topologyJson: "topology.json",
      ledgerJsonl: "ledger.jsonl",
      narrativeJson: "narrative.json",
      blastRadiusJson: "blast-radius.json",
      retryLoopsJson: "retry-loops.json",
      policySimulatorResultJson: "policy-simulator-result.json",
      integrationVerificationReceiptsJson: "integration-verification-receipts.json",
      artifactHashesJson: "artifact-hashes.json",
      manifestValidationJson: "manifest-validation.json",
      redactionSummaryJson: "redaction-summary.json",
      ...(replay.safe ? { replayInstructionsJson: "replay-instructions.json" } : {})
    },
    rawArtifacts: artifactCopies.rawRelativePaths,
    artifactHashes,
    reportManifestValidation,
    manifestValidation: provisionalValidation,
    redaction: { summaryFile: "redaction-summary.json" },
    replay: {
      safe: replay.safe,
      reason: replay.reason,
      ...(replay.safe ? { instructionsFile: "replay-instructions.json" } : {})
    }
  } satisfies EvidenceBundleManifest;

  const manifestPath = path.join(bundleDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifestWithoutValidation, null, 2)}\n`, "utf8");
  const validation = await validateEvidenceBundleManifest({ bundleDir });
  const manifest: EvidenceBundleManifest = { ...manifestWithoutValidation, manifestValidation: validation };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, "utf8");

  return { bundleId, bundleDir, manifestPath, validationPath, manifest, validation };
}

export async function validateEvidenceBundleManifest(input: { readonly bundleDir: string }): Promise<ManifestValidationResult> {
  const manifestPath = path.join(input.bundleDir, "manifest.json");
  let manifest: EvidenceBundleManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EvidenceBundleManifest;
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : "bundle manifest read failed"] };
  }

  const errors: string[] = [];
  const requiredFiles = Object.values(manifest.files).filter((file): file is string => typeof file === "string");
  for (const relativePath of requiredFiles) {
    try {
      await readFile(path.join(input.bundleDir, relativePath), "utf8");
    } catch {
      errors.push(`Missing bundle file reference: ${relativePath}`);
    }
  }

  for (const artifact of manifest.artifactHashes) {
    if (!artifact.sha256) {
      errors.push(`Missing hash for ${artifact.relativePath}`);
      continue;
    }
    try {
      const content = await readFile(path.join(input.bundleDir, artifact.relativePath));
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (sha256 !== artifact.sha256) {
        errors.push(`Hash mismatch for ${artifact.relativePath}`);
      }
    } catch {
      errors.push(`Missing hashed artifact: ${artifact.relativePath}`);
    }
  }

  const hashedPaths = new Set(manifest.artifactHashes.map((artifact) => artifact.relativePath));
  for (const relativePath of await listBundleFiles(input.bundleDir)) {
    if (relativePath === "manifest.json" || relativePath === "artifact-hashes.json") {
      continue;
    }
    if (!hashedPaths.has(relativePath)) {
      errors.push(`Missing hash entry for ${relativePath}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

async function copyEvidenceArtifacts(
  runDir: string,
  artifacts: readonly EvidenceArtifact[],
  evidenceDir: string
): Promise<{ readonly rawRelativePaths: readonly string[] }> {
  const rawRelativePaths: string[] = [];
  const safeRunDir = path.resolve(runDir);
  const bundleDir = path.dirname(evidenceDir);
  for (const artifact of artifacts) {
    const sourcePath = resolveArtifactSourcePath(safeRunDir, artifact);
    const raw = isRawArtifact(artifact);
    const basename = path.basename(artifact.relativePath);
    const targetRelative = raw
      ? path.join("evidence", "raw-untrusted", `${artifact.artifactId}-raw-untrusted-${basename}`)
      : path.join("evidence", `${artifact.artifactId}-${basename}`);
    const targetPath = path.resolve(bundleDir, targetRelative);
    if (!isWithinDirectory(path.resolve(bundleDir), targetPath)) {
      throw new Error(`Invalid bundle artifact target path for ${artifact.artifactId}: outside the bundle directory`);
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    if (raw) rawRelativePaths.push(targetRelative);
  }
  return { rawRelativePaths };
}

function isRawArtifact(artifact: EvidenceArtifact): boolean {
  return artifact.kind === "raw-result" || artifact.kind === "raw-stdout" || artifact.kind === "raw-stderr";
}

async function hashBundleFiles(bundleDir: string): Promise<readonly EvidenceBundleArtifactHash[]> {
  const relativePaths = (await listBundleFiles(bundleDir)).filter(
    (relativePath) =>
      relativePath !== "manifest.json" &&
      relativePath !== "artifact-hashes.json"
  );
  const hashes: EvidenceBundleArtifactHash[] = [];
  for (const relativePath of relativePaths) {
    const content = await readFile(path.join(bundleDir, relativePath));
    hashes.push({
      relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      byteLength: content.byteLength
    });
  }
  return hashes;
}

async function listBundleFiles(bundleDir: string, relativeDir = ""): Promise<string[]> {
  const dir = path.join(bundleDir, relativeDir);
  const entries = await readdir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry);
    const absolutePath = path.join(bundleDir, relativePath);
    if ((await stat(absolutePath)).isDirectory()) {
      files.push(...(await listBundleFiles(bundleDir, relativePath)));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function resolveArtifactSourcePath(safeRunDir: string, artifact: EvidenceArtifact): string {
  if (path.isAbsolute(artifact.relativePath)) {
    throw new Error(`Invalid artifact relativePath for ${artifact.artifactId}: absolute artifact paths are not allowed`);
  }
  const sourcePath = path.resolve(safeRunDir, artifact.relativePath);
  if (!isWithinDirectory(safeRunDir, sourcePath)) {
    throw new Error(`Invalid artifact relativePath for ${artifact.artifactId}: source path is outside the run directory`);
  }
  return sourcePath;
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

async function copyOptionalFile(source: string, target: string, fallback: string): Promise<void> {
  try {
    await copyFile(source, target);
  } catch {
    await writeFile(target, fallback, "utf8");
  }
}

function buildBlastRadius(ledger: readonly SideEffectLedgerEntry[]): JsonObject {
  return {
    explanations: ledger.map((entry) => ({
      ledgerId: entry.ledgerId,
      toolName: entry.toolName,
      score: entry.blastRadius.score,
      label: entry.blastRadius.label,
      factors: entry.blastRadius.factors.map((factor) => ({ ...factor })),
      summary: entry.summary
    }))
  };
}

function buildRetryLoops(ledger: readonly SideEffectLedgerEntry[]): JsonObject {
  const findings = ledger
    .map((entry) => entry.retryLoopFinding)
    .filter((finding): finding is RetryLoopFinding => Boolean(finding));
  return { findings: findings.map((finding) => ({ ...finding })) };
}

function buildReplayInstructions(runId: string, reason: string): JsonObject {
  return {
    runId,
    safety: reason,
    steps: [
      "Keep replay local. Do not use cloud credentials.",
      "Inspect events.jsonl, topology.json, ledger.jsonl, and narrative.json to reconstruct the run.",
      "Replay only the fixture-only or loopback scenario named in the bundle evidence.",
      "Treat files under evidence/raw-untrusted/ as untrusted raw evidence."
    ]
  };
}

function replayDecision(
  requested: EvidenceBundleReplaySafety | undefined,
  ledger: readonly SideEffectLedgerEntry[]
): { readonly safe: boolean; readonly reason: string } {
  if (requested?.fixtureOnly) return { safe: true, reason: "fixture-only replay" };
  if (requested?.safeLoopback) return { safe: true, reason: "safe loopback replay" };
  const ledgerSafe =
    ledger.length > 0 &&
    ledger.every((entry) => entry.reversibility === "fixture-only" || entry.targetType === "network-loopback");
  return ledgerSafe
    ? { safe: true, reason: "ledger contains only fixture-only or loopback side effects" }
    : { safe: false, reason: "replay instructions withheld because this run is not fixture-only or safe loopback" };
}

function extractEventData<T>(events: readonly { readonly type: string; readonly data?: unknown }[], type: string): T[] {
  return events.filter((event) => event.type === type).map((event) => event.data as T).filter(Boolean);
}

function isEvidenceArtifact(value: unknown): value is EvidenceArtifact {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as EvidenceArtifact).artifactId === "string" &&
    typeof (value as EvidenceArtifact).relativePath === "string" &&
    typeof (value as EvidenceArtifact).kind === "string"
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, sortJson(val)]));
  }
  return value;
}
