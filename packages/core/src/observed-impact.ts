import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  FileMetadata,
  ImpactAttributionLevel,
  ImpactEvidenceBasis,
  ObservedFileChange,
  ObservedLocalImpact,
  ObservedProcessLifecycle,
  SideEffectState,
  ToolCall
} from "./types.js";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "coverage", "bundle"]);
const MAX_SNAPSHOT_FILES = 500;

interface WorkspaceSnapshot {
  readonly workspaceRoot: string;
  readonly disposableWorkspace: boolean;
  readonly pathContainment: "contained" | "rejected";
  readonly gitStatus?: readonly string[];
  readonly files: ReadonlyMap<string, FileMetadata>;
}

export interface ObservedImpactStart {
  readonly snapshot?: WorkspaceSnapshot;
}

export interface ObservedImpactRouteMetadata {
  readonly workspaceRoot?: string;
  readonly sandboxRoot?: string;
}

export function workspaceRootFromCall(
  call: ToolCall,
  routeMetadata?: ObservedImpactRouteMetadata | undefined
): string | undefined {
  const candidate = firstNonEmptyString(
    call.arguments.cwd,
    call.routeMetadata?.workspaceRoot,
    call.routeMetadata?.sandboxRoot,
    routeMetadata?.workspaceRoot,
    routeMetadata?.sandboxRoot
  );
  return candidate;
}

export function observedProcessLifecycleFromValue(value: unknown): ObservedProcessLifecycle | undefined {
  const record = Array.isArray(value) ? Object.fromEntries(value.map((line) => String(line).split(/: /, 2)).filter((parts) => parts.length === 2)) : value;
  if (!isRecord(record) || typeof record.startedAt !== "string" || typeof record.endedAt !== "string") return undefined;
  return {
    pid: typeof record.pid === "number" ? record.pid : numberOrNull(record.pid),
    processGroupId: typeof record.processGroupId === "number" ? record.processGroupId : numberOrNull(record.processGroupId),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: typeof record.exitCode === "number" ? record.exitCode : numberOrNull(record.exitCode),
    signal: typeof record.signal === "string" && record.signal !== "null" ? record.signal : null,
    timedOut: record.timedOut === true || record.timedOut === "true",
    cancelled: record.cancelled === true || record.cancelled === "true",
    cleanupResult: isCleanupResult(record.cleanupResult) ? record.cleanupResult : "unknown",
    terminationSignals: Array.isArray(record.terminationSignals)
      ? record.terminationSignals.map(String)
      : typeof record.terminationSignals === "string" && record.terminationSignals.length > 0
        ? record.terminationSignals.split(",").filter(Boolean)
        : []
  };
}

export async function startObservedImpact(
  call: ToolCall,
  routeMetadata?: ObservedImpactRouteMetadata | undefined
): Promise<ObservedImpactStart> {
  const workspaceRoot = workspaceRootFromCall(call, routeMetadata);
  if (!workspaceRoot) return {};
  const resolved = path.resolve(workspaceRoot);
  const disposableWorkspace = isDisposableWorkspace(resolved);
  const gitStatus = await readGitStatus(resolved);
  const files = disposableWorkspace ? await snapshotFiles(resolved) : new Map<string, FileMetadata>();
  return {
    snapshot: {
      workspaceRoot: resolved,
      disposableWorkspace,
      pathContainment: "contained",
      ...(gitStatus ? { gitStatus } : {}),
      files
    }
  };
}

export async function finishObservedImpact(input: {
  readonly start?: ObservedImpactStart;
  readonly call: ToolCall;
  readonly outcome: SideEffectState;
  readonly tempArtifactWrites: readonly string[];
  readonly processLifecycle?: ObservedProcessLifecycle | undefined;
  readonly routeMetadata?: ObservedImpactRouteMetadata | undefined;
}): Promise<ObservedLocalImpact | undefined> {
  const before = input.start?.snapshot;
  const workspaceRoot = before?.workspaceRoot ?? workspaceRootFromCall(input.call, input.routeMetadata);
  if (!workspaceRoot || !before || before.pathContainment !== "contained") return undefined;

  const afterGitStatus = await readGitStatus(before.workspaceRoot);
  const afterFiles = before.disposableWorkspace ? await snapshotFiles(before.workspaceRoot) : new Map<string, FileMetadata>();
  const fileChanges = before.disposableWorkspace ? diffSnapshots(before.files, afterFiles) : [];
  const rollbackGuidance = buildRollbackGuidance(fileChanges, before.workspaceRoot);
  const bundleHashes = hashImpactSummary({
    workspaceRoot: before.workspaceRoot,
    fileChanges,
    gitStatus: before.gitStatus || afterGitStatus ? { before: before.gitStatus ?? [], after: afterGitStatus ?? [] } : undefined,
    processLifecycle: input.processLifecycle
  });

  const impact: ObservedLocalImpact = {
    workspaceRoot: before.workspaceRoot,
    disposableWorkspace: before.disposableWorkspace,
    pathContainment: "contained",
    ...(before.gitStatus || afterGitStatus
      ? {
          gitStatus: {
            before: before.gitStatus ?? [],
            after: afterGitStatus ?? [],
            changed: (before.gitStatus ?? []).join("\n") !== (afterGitStatus ?? []).join("\n")
          }
        }
      : {}),
    fileChanges,
    tempArtifactWrites: input.tempArtifactWrites,
    ...(input.processLifecycle ? { processLifecycle: input.processLifecycle } : {}),
    outcome: chooseImpactOutcome(input.outcome, fileChanges, before.gitStatus, afterGitStatus),
    rollbackGuidance,
    bundleHashes
  };
  return impact;
}

export function impactAttribution(input: {
  readonly outcome: SideEffectState;
  readonly impact?: ObservedLocalImpact | undefined;
}): {
  readonly attributionLevel: ImpactAttributionLevel;
  readonly evidenceBasis: readonly ImpactEvidenceBasis[];
  readonly causalClaim: string;
  readonly counterEvidence: readonly string[];
} {
  if (input.outcome === "blocked") {
    return {
      attributionLevel: "blocked-before-execution",
      evidenceBasis: ["policy-decision"],
      causalClaim: "ToolGuard blocked the command before downstream execution, so no executed local mutation is attributed.",
      counterEvidence: []
    };
  }
  const basis: ImpactEvidenceBasis[] = [];
  const counterEvidence: string[] = [];
  if (input.impact?.fileChanges.length) basis.push("filesystem-diff");
  if (input.impact?.gitStatus) basis.push("git-status-diff");
  if (input.impact?.processLifecycle) basis.push("process-lifecycle");
  if (input.impact?.tempArtifactWrites.length) basis.push("artifact-write");
  if (input.impact && input.impact.fileChanges.length === 0 && input.impact.gitStatus?.changed !== true) {
    basis.push("postflight-no-mutation");
    counterEvidence.push(
      input.impact.gitStatus
        ? "Postflight filesystem/git observation found no workspace mutation."
        : "Postflight filesystem observation found no workspace mutation."
    );
  }
  if (!input.impact && input.outcome === "unknown") basis.push("timeout-no-postflight");

  const hasObservedMutation = Boolean(input.impact?.fileChanges.length || input.impact?.gitStatus?.changed);
  return {
    attributionLevel: hasObservedMutation ? "observed-after" : input.impact ? "observed-caused" : input.outcome === "unknown" ? "unknown" : "inferred-risk",
    evidenceBasis: basis.length > 0 ? basis : ["policy-decision"],
    causalClaim: hasObservedMutation
      ? "Local changes were observed after the mediated call in the contained workspace."
      : input.impact
        ? "No local mutation was observed by postflight checks for this mediated call."
        : "No postflight local impact observation was available; attribution is limited to inferred call outcome.",
    counterEvidence
  };
}

function chooseImpactOutcome(
  outcome: SideEffectState,
  fileChanges: readonly ObservedFileChange[],
  beforeGitStatus: readonly string[] | undefined,
  afterGitStatus: readonly string[] | undefined
): SideEffectState {
  const gitChanged = Boolean(beforeGitStatus || afterGitStatus) && (beforeGitStatus ?? []).join("\n") !== (afterGitStatus ?? []).join("\n");
  if (outcome === "unknown") {
    return fileChanges.length === 0 && !gitChanged ? "none" : "unknown";
  }
  if (fileChanges.length > 0 || gitChanged) return "completed";
  return outcome;
}

function buildRollbackGuidance(changes: readonly ObservedFileChange[], workspaceRoot: string): readonly string[] {
  if (changes.length === 0) return ["No observed workspace file changes require rollback."];
  return changes.map((change) => {
    const safePath = containedRelativePath(workspaceRoot, path.join(workspaceRoot, change.path));
    if (change.changeType === "created") return `Remove created disposable-workspace path ${safePath}.`;
    if (change.changeType === "deleted") return `Restore deleted disposable-workspace path ${safePath} from source control or fixture seed.`;
    return `Review and revert modified disposable-workspace path ${safePath}.`;
  });
}

function hashImpactSummary(value: unknown): ObservedLocalImpact["bundleHashes"] {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  return [
    {
      relativePath: "impact-summary",
      sha256: createHash("sha256").update(text).digest("hex"),
      byteLength: Buffer.byteLength(text, "utf8")
    }
  ];
}

function diffSnapshots(before: ReadonlyMap<string, FileMetadata>, after: ReadonlyMap<string, FileMetadata>): ObservedFileChange[] {
  const changes: ObservedFileChange[] = [];
  for (const [relativePath, metadata] of after) {
    const previous = before.get(relativePath);
    if (!previous) {
      changes.push({ path: relativePath, changeType: "created", after: metadata });
    } else if (previous.sha256 !== metadata.sha256 || previous.sizeBytes !== metadata.sizeBytes || previous.type !== metadata.type) {
      changes.push({ path: relativePath, changeType: "modified", before: previous, after: metadata });
    }
  }
  for (const [relativePath, metadata] of before) {
    if (!after.has(relativePath)) {
      changes.push({ path: relativePath, changeType: "deleted", before: metadata });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function snapshotFiles(root: string): Promise<ReadonlyMap<string, FileMetadata>> {
  const files = new Map<string, FileMetadata>();
  await walk(root, root, files);
  return files;
}

async function walk(root: string, directory: string, files: Map<string, FileMetadata>): Promise<void> {
  if (files.size >= MAX_SNAPSHOT_FILES) return;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (IGNORED_DIRS.has(entry) || entry.startsWith("run_") || entry === "run-index.jsonl" || files.size >= MAX_SNAPSHOT_FILES) continue;
    const absolutePath = path.join(directory, entry);
    const relativePath = containedRelativePath(root, absolutePath);
    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      files.set(relativePath, { type: "directory", sizeBytes: 0, mtimeMs: Math.trunc(info.mtimeMs) });
      await walk(root, absolutePath, files);
    } else if (info.isFile()) {
      const content = await readFile(absolutePath);
      files.set(relativePath, {
        type: "file",
        sizeBytes: content.byteLength,
        mtimeMs: Math.trunc(info.mtimeMs),
        sha256: createHash("sha256").update(content).digest("hex")
      });
    } else {
      files.set(relativePath, { type: "other", sizeBytes: info.size, mtimeMs: Math.trunc(info.mtimeMs) });
    }
  }
}

function containedRelativePath(root: string, candidate: string): string {
  const safeRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== safeRoot && !resolved.startsWith(`${safeRoot}${path.sep}`)) {
    throw new Error(`Observed impact path escapes workspace root: ${candidate}`);
  }
  return path.relative(safeRoot, resolved) || ".";
}

function isDisposableWorkspace(workspaceRoot: string): boolean {
  const tempRoot = path.resolve(tmpdir());
  return workspaceRoot === tempRoot || workspaceRoot.startsWith(`${tempRoot}${path.sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === "null" || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCleanupResult(value: unknown): value is ObservedProcessLifecycle["cleanupResult"] {
  return ["not-needed", "terminated", "force-killed", "already-exited", "unknown"].includes(String(value));
}

async function readGitStatus(cwd: string): Promise<readonly string[] | undefined> {
  return await new Promise((resolve) => {
    const child = spawn("git", ["status", "--short"], { cwd, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(undefined);
    }, 1_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0 ? output.split("\n").filter(Boolean) : undefined);
    });
  });
}
