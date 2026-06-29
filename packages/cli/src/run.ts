import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ClassifiedToolError,
  CoreSession,
  ToolRegistry,
  createId,
  redactStringWithSummary,
  type FailureCard,
  type FailureType,
  type JsonObject,
  type StableId,
  type ToolCall,
  type ToolResult
} from "@toolplane/core";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const FIXTURE_ONLY_SUMMARY = "fixture-only destructive command was safely simulated without spawning a process.";
const CLAIM_LEVEL =
  "ToolGuard CLI supervision is process-level only; native tool interception requires MCP, SDK wrappers, or ToolGuard APIs.";

export interface ToolplaneCliOptions {
  readonly executableName?: "toolplane" | "toolguard";
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
  readonly signal?: AbortSignal;
}

export interface ToolplaneRunResult {
  readonly runId: StableId;
  readonly eventsPath: string;
  readonly evidenceDir: string;
  readonly exitCode: number;
  readonly process?: ProcessExecutionSummary;
  readonly result?: ToolResult;
  readonly failureCard?: FailureCard;
}

export interface ProcessExecutionSummary extends JsonObject {
  readonly command: string;
  readonly argv: string[];
  readonly cwd: string;
  readonly envKeys: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutRedactionCount: number;
  readonly stderrRedactionCount: number;
  readonly redactionReasons: string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly claimLevel: string;
}

interface ParsedRunOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly evidenceRoot: string;
  readonly coreUrl?: string;
  readonly fixtureOnly: boolean;
  readonly json: boolean;
  readonly runName?: string;
  readonly tags: readonly string[];
  readonly labels: NonNullable<ToolCall["labels"]>;
}

interface DestructiveAssessment {
  readonly destructive: boolean;
  readonly reason: string;
}

export async function runToolplaneCli(
  argv: readonly string[],
  options: ToolplaneCliOptions = {}
): Promise<ToolplaneRunResult> {
  const executableName = options.executableName ?? "toolplane";
  const parsed = parseToolplaneRunArgs(argv);
  await mkdir(parsed.evidenceRoot, { recursive: true });

  const session = new CoreSession({
    evidenceRoot: parsed.evidenceRoot,
    runId: createId("run"),
    outputLimitBytes: parsed.outputLimitBytes
  });
  const coreUrl = parsed.coreUrl ?? process.env.TOOLGUARD_CORE_URL;
  const forwardedEvents: Promise<void>[] = [];
  if (coreUrl) {
    session.bus.subscribe((event) => {
      forwardedEvents.push(forwardEventToCoreApi(coreUrl, event));
    });
  }
  const call = makeProcessToolCall(session.runId, parsed);
  const assessment = assessDestructiveCommand(parsed.command);
  const registry = new ToolRegistry();
  let lastProcessSummary: ProcessExecutionSummary | undefined;

  await session.emitAdapterConnected(
    {
      runId: call.runId,
      traceId: call.traceId,
      harnessId: call.harnessId,
      adapterId: call.adapterId,
      downstreamServerId: call.downstreamServerId
    },
    `${executableName} CLI process wrapper connected`
  );

  registry.register({
    toolName: "process.exec",
    title: "Process execution wrapper",
    description: "Runs a process with argv boundaries preserved and shell execution disabled.",
    protocol: "process",
    downstreamServerId: call.downstreamServerId,
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "array" },
        cwd: { type: "string" },
        fixtureOnly: { type: "boolean" }
      }
    },
    destructiveRisk: assessment.destructive ? "high" : "none",
    preflight: () => ({
      status: "healthy",
      summary: assessment.destructive
        ? `Command classified as destructive: ${assessment.reason}`
        : "Command passed CLI process preflight."
    }),
    execute: async ({ signal, call: activeCall }) => {
      if (assessment.destructive && parsed.fixtureOnly) {
        return {
          status: "simulated",
          safeSummary: FIXTURE_ONLY_SUMMARY,
          command: parsed.command[0] ?? "",
          argv: parsed.command.slice(1),
          cwd: parsed.cwd,
          claimLevel: CLAIM_LEVEL
        };
      }

      const summary = await executeProcess(parsed, signal);
      lastProcessSummary = summary;
      const stdoutArtifact = await session.recordRawArtifact(activeCall, {
        kind: "raw-stdout",
        fileName: `${activeCall.toolCallId}.stdout.txt`,
        content: summary.stdout,
        redacted: summary.stdoutRedactionCount > 0
      });
      const stderrArtifact = await session.recordRawArtifact(activeCall, {
        kind: "raw-stderr",
        fileName: `${activeCall.toolCallId}.stderr.txt`,
        content: summary.stderr,
        redacted: summary.stderrRedactionCount > 0
      });
      const redactionCount = summary.stdoutRedactionCount + summary.stderrRedactionCount;
      if (redactionCount > 0) {
        await session.emitOutputSanitized(activeCall, "CLI process stream output was redacted for model safety.", {
          reason: "secret_redaction",
          artifactId: stdoutArtifact.artifactId,
          redactionCount,
          reasons: summary.redactionReasons,
          streams: [
            ...(summary.stdoutRedactionCount > 0 ? ["stdout"] : []),
            ...(summary.stderrRedactionCount > 0 ? ["stderr"] : [])
          ]
        });
        if (summary.stderrRedactionCount > 0) {
          await session.emitOutputSanitized(activeCall, "CLI stderr stream output was redacted for model safety.", {
            reason: "secret_redaction",
            artifactId: stderrArtifact.artifactId,
            redactionCount: summary.stderrRedactionCount,
            reasons: summary.redactionReasons,
            streams: ["stderr"]
          });
        }
      }

      const failureType = classifyProcessSummary(summary);
      if (failureType) {
        throw new ClassifiedToolError(failureType, processFailureMessage(summary, failureType), [
          `command: ${summary.command}`,
          `argv: ${JSON.stringify(summary.argv)}`,
          `cwd: ${summary.cwd}`,
          `exitCode: ${String(summary.exitCode)}`,
          `signal: ${String(summary.signal)}`,
          `timedOut: ${String(summary.timedOut)}`,
          `cancelled: ${String(summary.cancelled)}`,
          `stdout: ${summary.stdout}`,
          `stderr: ${summary.stderr}`
        ]);
      }
      return summary;
    }
  });

  const mediated = await session.executeToolCall(registry, call, options.signal ? { signal: options.signal } : {});
  await session.recorder.flushRunIndex();
  await Promise.allSettled(forwardedEvents);
  const result = "failureType" in mediated ? undefined : withCliSafeSummary(mediated);
  const failureCard = "failureType" in mediated ? mediated : undefined;
  const processSummary = extractProcessSummary(result) ?? lastProcessSummary;
  const exitCode = exitCodeFor(mediated, processSummary, assessment, parsed.fixtureOnly);

  const runResult: ToolplaneRunResult = {
    runId: session.runId,
    eventsPath: session.recorder.eventsPath,
    evidenceDir: session.recorder.runDir,
    exitCode,
    ...(processSummary ? { process: processSummary } : {}),
    ...(result ? { result } : {}),
    ...(failureCard ? { failureCard } : {})
  };

  renderRunResult(runResult, parsed, options);
  return runResult;
}

export function parseToolplaneRunArgs(argv: readonly string[]): ParsedRunOptions {
  if (argv[0] !== "run") {
    throw new Error("Usage: toolplane run [--timeout-ms N] [--cwd PATH] [--env KEY=VALUE] [--stdin TEXT] -- <command>");
  }

  const separatorIndex = argv.indexOf("--");
  if (separatorIndex < 0) {
    throw new Error("toolplane run requires -- before the command so argv boundaries stay explicit.");
  }

  const optionArgs = argv.slice(1, separatorIndex);
  const command = argv.slice(separatorIndex + 1);
  if (command.length === 0) {
    throw new Error("toolplane run requires a command after --.");
  }

  let cwd = process.cwd();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES;
  let evidenceRoot = path.join(process.cwd(), "runs");
  let coreUrl: string | undefined;
  let stdin: string | undefined;
  let fixtureOnly = false;
  let json = false;
  let runName: string | undefined;
  const tags: string[] = [];
  const labels: { session?: string; task?: string; repo?: string; agent?: string } = labelsFromEnvironment(process.env);
  const env: Record<string, string> = {};

  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];
    switch (option) {
      case "--cwd":
        cwd = requireValue(optionArgs, ++index, "--cwd");
        break;
      case "--timeout-ms":
        timeoutMs = parsePositiveInteger(requireValue(optionArgs, ++index, "--timeout-ms"), "--timeout-ms");
        break;
      case "--output-limit-bytes":
        outputLimitBytes = parsePositiveInteger(
          requireValue(optionArgs, ++index, "--output-limit-bytes"),
          "--output-limit-bytes"
        );
        break;
      case "--evidence-root":
        evidenceRoot = requireValue(optionArgs, ++index, "--evidence-root");
        break;
      case "--core-url":
        coreUrl = requireValue(optionArgs, ++index, "--core-url").replace(/\/+$/, "");
        break;
      case "--env": {
        const assignment = requireValue(optionArgs, ++index, "--env");
        const equalsIndex = assignment.indexOf("=");
        if (equalsIndex <= 0) {
          throw new Error("--env must be KEY=VALUE.");
        }
        env[assignment.slice(0, equalsIndex)] = assignment.slice(equalsIndex + 1);
        break;
      }
      case "--stdin":
        stdin = requireValue(optionArgs, ++index, "--stdin");
        break;
      case "--fixture-only":
        fixtureOnly = true;
        break;
      case "--json":
        json = true;
        break;
      case "--run-name":
        runName = requireValue(optionArgs, ++index, "--run-name");
        break;
      case "--tag":
        tags.push(requireValue(optionArgs, ++index, "--tag"));
        break;
      case "--session-label":
        labels.session = requireValue(optionArgs, ++index, "--session-label");
        break;
      case "--task-label":
        labels.task = requireValue(optionArgs, ++index, "--task-label");
        break;
      case "--repo-label":
        labels.repo = requireValue(optionArgs, ++index, "--repo-label");
        break;
      case "--agent-label":
        labels.agent = requireValue(optionArgs, ++index, "--agent-label");
        break;
      default:
        throw new Error(`Unknown toolplane run option: ${String(option)}`);
    }
  }

  return {
    command,
    cwd,
    env,
    ...(stdin !== undefined ? { stdin } : {}),
    timeoutMs,
    outputLimitBytes,
    evidenceRoot,
    ...(coreUrl ? { coreUrl } : {}),
    fixtureOnly,
    json,
    ...(runName ? { runName } : {}),
    tags,
    labels
  };
}

async function forwardEventToCoreApi(coreUrl: string, event: unknown): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 250);
  try {
    await fetch(`${coreUrl}/api/events/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: controller.signal
    });
  } catch {
    // CLI execution must not fail open or hang because the optional local API is unavailable.
  } finally {
    clearTimeout(timeout);
  }
}

async function executeProcess(parsed: ParsedRunOptions, signal: AbortSignal): Promise<ProcessExecutionSummary> {
  const startedAt = Date.now();
  const command = parsed.command[0];
  if (!command) {
    throw new ClassifiedToolError("spawn_failure", "Missing command after --.");
  }
  const args = parsed.command.slice(1);
  const env = { ...process.env, ...parsed.env };

  return await new Promise<ProcessExecutionSummary>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: parsed.cwd,
      env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      signal.removeEventListener("abort", abortChild);
    };
    const finish = (summary: ProcessExecutionSummary): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(summary);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const current = stream === "stdout" ? stdout : stderr;
      const alreadyTruncated = stream === "stdout" ? stdoutTruncated : stderrTruncated;
      if (alreadyTruncated) {
        return;
      }
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > parsed.outputLimitBytes) {
        const limited = truncateUtf8(next, parsed.outputLimitBytes);
        if (stream === "stdout") {
          stdout = `${limited}\n[truncated]`;
          stdoutTruncated = true;
        } else {
          stderr = `${limited}\n[truncated]`;
          stderrTruncated = true;
        }
        return;
      }
      if (stream === "stdout") {
        stdout = next;
      } else {
        stderr = next;
      }
    };
    const terminateChildTree = (reason: "timeout" | "cancellation"): void => {
      if (reason === "timeout") {
        timedOut = true;
      } else {
        cancelled = true;
      }
      signalProcessTree(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), 250);
    };
    const abortChild = (): void => {
      terminateChildTree("cancellation");
    };
    const timeout = setTimeout(() => {
      terminateChildTree("timeout");
    }, parsed.timeoutMs);

    child.once("error", (error) => {
      fail(new ClassifiedToolError("spawn_failure", error.message, [error.message]));
    });
    child.stdout?.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
    child.once("close", (exitCode, exitSignal) => {
      const stdoutRedaction = redactStringWithSummary(stdout);
      const stderrRedaction = redactStringWithSummary(stderr);
      finish({
        command,
        argv: args,
        cwd: parsed.cwd,
        envKeys: Object.keys(parsed.env).sort(),
        stdout: stdoutRedaction.value,
        stderr: stderrRedaction.value,
        stdoutTruncated,
        stderrTruncated,
        stdoutRedactionCount: stdoutRedaction.count,
        stderrRedactionCount: stderrRedaction.count,
        redactionReasons: [...new Set([...stdoutRedaction.reasons, ...stderrRedaction.reasons])],
        exitCode,
        signal: exitSignal,
        elapsedMs: Date.now() - startedAt,
        timedOut,
        cancelled,
        claimLevel: CLAIM_LEVEL
      });
    });

    signal.addEventListener("abort", abortChild, { once: true });
    if (signal.aborted) {
      abortChild();
    }
    if (parsed.stdin !== undefined) {
      child.stdin?.end(parsed.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have already exited between timeout/cancellation and signal delivery.
    }
  }
}

function makeProcessToolCall(runId: StableId, parsed: ParsedRunOptions): ToolCall {
  return {
    runId,
    traceId: createId("trace"),
    parentId: createId("parent"),
    harnessId: "harness_cli" as StableId,
    harnessName: "cli",
    adapterId: "adapter_cli_wrapper" as StableId,
    adapterName: "toolguard-cli-wrapper",
    downstreamServerId: "server_local_process" as StableId,
    toolCallId: createId("toolcall"),
    attemptId: createId("attempt"),
    policyDecisionId: createId("policy"),
    toolName: "process.exec",
    ...(parsed.command[0] ? { originalToolName: parsed.command[0] } : {}),
    arguments: {
      command: parsed.command as string[],
      cwd: parsed.cwd,
      envKeys: Object.keys(parsed.env).sort(),
      fixtureOnly: parsed.fixtureOnly,
      timeoutMs: parsed.timeoutMs,
      outputLimitBytes: parsed.outputLimitBytes,
      claimLevel: CLAIM_LEVEL
    },
    deadlineMs: parsed.timeoutMs + 1_000,
    idempotency: idempotencyFor(parsed.command),
    sourcePath: "cli-wrapper",
    runName: parsed.runName ?? `cli ${parsed.command[0] ?? "process"}`,
    tags: parsed.tags,
    labels: parsed.labels
  };
}

function classifyProcessSummary(summary: ProcessExecutionSummary): FailureType | undefined {
  if (summary.timedOut) {
    return "timeout";
  }
  if (summary.cancelled) {
    return "cancellation";
  }
  if (summary.stdoutTruncated || summary.stderrTruncated) {
    return "output_limit_exceeded";
  }
  if (summary.exitCode !== 0) {
    return "non_zero_exit";
  }
  return undefined;
}

function processFailureMessage(summary: ProcessExecutionSummary, failureType: FailureType): string {
  if (failureType === "timeout") {
    return `Process timed out after ${summary.elapsedMs}ms.`;
  }
  if (failureType === "cancellation") {
    return "Process was cancelled.";
  }
  if (failureType === "output_limit_exceeded") {
    return "Process output exceeded the configured limit.";
  }
  return `Process exited with code ${String(summary.exitCode)}.`;
}

function assessDestructiveCommand(command: readonly string[]): DestructiveAssessment {
  const executable = path.basename(command[0] ?? "");
  const args = command.slice(1);
  const joined = command.join(" ");
  const shellText = shellCommandText(executable, args);

  if (["rm", "rmdir", "unlink", "shred", "truncate"].includes(executable)) {
    return { destructive: true, reason: `${executable} can remove filesystem paths.` };
  }
  if (["dd", "mkfs", "mount", "umount"].includes(executable)) {
    return { destructive: true, reason: `${executable} can modify disks, filesystems, or mounted data.` };
  }
  if (executable === "mv" && args.length >= 2) {
    return { destructive: true, reason: "mv can overwrite or move user-owned files." };
  }
  if (executable === "cp" && args.length >= 2 && (args.some((arg) => arg === "-f" || arg.includes("f")) || args.length > 2)) {
    return { destructive: true, reason: "cp can overwrite user-owned files." };
  }
  if (["chmod", "chown", "chgrp"].includes(executable) && args.some((arg) => /^-.*R/.test(arg) || arg === "--recursive")) {
    return { destructive: true, reason: `${executable} recursive changes can damage workspace permissions or ownership.` };
  }
  if (executable === "git" && isDestructiveGit(args)) {
    return { destructive: true, reason: `git ${args.join(" ")} may discard work or modify remotes.` };
  }
  if ((executable === "git" && ["checkout", "switch", "restore"].includes(args[0] ?? "")) || joined.includes("rm -rf")) {
    return { destructive: true, reason: "Command can overwrite, discard, or delete workspace files." };
  }
  if (shellText && isDestructiveShellText(shellText)) {
    return {
      destructive: true,
      reason: "Shell command text contains destructive filesystem, redirection, move/copy overwrite, or git usage."
    };
  }
  return { destructive: false, reason: "No destructive pattern matched." };
}

function shellCommandText(executable: string, args: readonly string[]): string | undefined {
  if (!["sh", "bash", "zsh"].includes(executable)) {
    return undefined;
  }
  const commandFlagIndex = args.findIndex((arg) => arg === "-c" || arg.endsWith("c"));
  if (commandFlagIndex >= 0 && args[commandFlagIndex + 1]) {
    return args[commandFlagIndex + 1];
  }
  return args.join(" ");
}

function isDestructiveGit(args: readonly string[]): boolean {
  const subcommand = args[0] ?? "";
  if (subcommand === "clean") {
    return args.some((arg) => arg.includes("f") || arg === "--force" || arg === "-d");
  }
  if (subcommand === "reset") {
    return args.some((arg) => ["--hard", "--merge", "--keep"].includes(arg));
  }
  if (subcommand === "push") {
    return args.some((arg) => arg === "--force" || arg === "--force-with-lease" || arg === "-f");
  }
  if (["checkout", "switch", "restore"].includes(subcommand)) {
    return args.some((arg) => arg === "-f" || arg === "--force" || arg === "--hard" || arg === "--discard-changes");
  }
  return false;
}

function isDestructiveShellText(text: string): boolean {
  const destructivePatterns = [
    /\brm\s+[^;&|]*(-[A-Za-z]*[rf]|--recursive|--force)\b/,
    /\bmv\b(?=[^;&|]*\s+\S+\s+\S+)/,
    /\bcp\b(?=[^;&|]*(?:\s-[A-Za-z]*[fRr][A-Za-z]*\b|\s--(?:force|remove-destination|recursive)\b))(?=[^;&|]*\s+\S+\s+\S+)/,
    /\bfind\b[^;&|]*\s-delete\b/,
    /\btruncate\s+(-s|--size)\b/,
    /\bdd\b[^;&|]*\bof=/,
    /\bmkfs(?:\.[A-Za-z0-9_-]+)?\b/,
    /\b(?:chmod|chown|chgrp)\s+(?:-[A-Za-z]*R|--recursive)\b/,
    /\bgit\s+clean\b[^;&|]*(?:-[A-Za-z]*f|--force)\b/,
    /\bgit\s+reset\b[^;&|]*--hard\b/,
    /\bgit\s+push\b[^;&|]*(?:-f|--force|--force-with-lease)\b/,
    /(^|[^<])>\s*[^>|&\s][^;&|]*/
  ];
  return destructivePatterns.some((pattern) => pattern.test(text));
}

function idempotencyFor(command: readonly string[]): ToolCall["idempotency"] {
  const executable = path.basename(command[0] ?? "");
  if (executable === "git" && ["status", "diff", "log", "show", "rev-parse"].includes(command[1] ?? "")) {
    return "idempotent";
  }
  if (["node", "pnpm", "npm", "vitest"].includes(executable) || command[0] === process.execPath) {
    return "idempotent";
  }
  return "unknown";
}

function extractProcessSummary(result: ToolResult | undefined): ProcessExecutionSummary | undefined {
  const output = result?.output;
  if (!isRecord(output) || typeof output.command !== "string" || !Array.isArray(output.argv)) {
    return undefined;
  }
  return output as unknown as ProcessExecutionSummary;
}

function withCliSafeSummary(result: ToolResult): ToolResult {
  const output = result.output;
  if (isRecord(output) && typeof output.safeSummary === "string") {
    return { ...result, safeSummary: output.safeSummary };
  }
  return result;
}

function exitCodeFor(
  mediated: ToolResult | FailureCard,
  summary: ProcessExecutionSummary | undefined,
  assessment: DestructiveAssessment,
  fixtureOnly: boolean
): number {
  if (!("failureType" in mediated)) {
    return 0;
  }
  if (mediated.failureType === "timeout") {
    return 124;
  }
  if (mediated.failureType === "cancellation") {
    return 130;
  }
  if (mediated.failureType === "spawn_failure") {
    return 127;
  }
  if (mediated.failureType === "destructive_action_blocked" || (assessment.destructive && !fixtureOnly)) {
    return 2;
  }
  return typeof summary?.exitCode === "number" && summary.exitCode > 0 ? summary.exitCode : 1;
}

function renderRunResult(result: ToolplaneRunResult, parsed: ParsedRunOptions, options: ToolplaneCliOptions): void {
  if (!options.stdout && !options.stderr) {
    return;
  }
  const stdout = options.stdout ?? (() => undefined);
  const stderr = options.stderr ?? (() => undefined);

  if (parsed.json) {
    stdout(`${JSON.stringify(redactForDisplay(result), null, 2)}\n`);
    return;
  }

  stdout(`ToolGuard CLI run ${result.runId}\n`);
  stdout(`Evidence: ${result.evidenceDir}\n`);
  stdout(`Events: ${result.eventsPath}\n`);
  if (result.process) {
    stdout(`Command: ${result.process.command} ${result.process.argv.join(" ")}\n`);
    stdout(`Exit: ${String(result.process.exitCode)} elapsed=${result.process.elapsedMs}ms timeout=${result.process.timedOut}\n`);
    if (result.process.stdout.trim().length > 0) {
      stdout(`\n[stdout]\n${result.process.stdout}\n`);
    }
    if (result.process.stderr.trim().length > 0) {
      stderr(`\n[stderr]\n${result.process.stderr}\n`);
    }
  }
  if (result.failureCard) {
    stderr(`\nFailure Card: ${result.failureCard.failureType}\n`);
    stderr(`${result.failureCard.safeSummary}\n`);
    stderr(`Retry same call: ${String(!result.failureCard.doNotRetrySameCall)}\n`);
  } else if (result.result) {
    stdout(`\n${result.result.safeSummary}\n`);
  }
}

function requireValue(values: readonly string[], index: number, optionName: string): string {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

function labelsFromEnvironment(env: NodeJS.ProcessEnv): { session?: string; task?: string; repo?: string; agent?: string } {
  return {
    ...(env.TOOLGUARD_SESSION_LABEL ? { session: env.TOOLGUARD_SESSION_LABEL } : {}),
    ...(env.TOOLGUARD_TASK_LABEL ? { task: env.TOOLGUARD_TASK_LABEL } : {}),
    ...(env.TOOLGUARD_REPO_LABEL ? { repo: env.TOOLGUARD_REPO_LABEL } : {}),
    ...(env.TOOLGUARD_AGENT_LABEL ? { agent: env.TOOLGUARD_AGENT_LABEL } : {})
  };
}

function truncateUtf8(value: string, limitBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= limitBytes) {
    return value;
  }
  return buffer.subarray(0, Math.max(0, limitBytes)).toString("utf8");
}

function redactForDisplay(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultEvidenceRoot(): string {
  return path.join(tmpdir(), "toolguard-runs");
}
