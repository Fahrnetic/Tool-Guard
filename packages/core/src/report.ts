import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "./ids.js";
import { redactJsonValue, redactJsonValueWithSummary, redactStringWithSummary } from "./redaction.js";
import type { CoreEvent } from "./events.js";
import type { EvidenceArtifact, FailureCard, ReportManifest } from "./types.js";

export interface StaticReportResult {
  readonly reportId: string;
  readonly reportPath: string;
  readonly manifestPath: string;
  readonly artifactHashPath: string;
  readonly redactionSummaryPath: string;
}

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export async function exportStaticReport(input: { readonly runDir: string }): Promise<StaticReportResult> {
  await mkdir(input.runDir, { recursive: true });
  const eventsPath = path.join(input.runDir, "events.jsonl");
  const ledgerPath = path.join(input.runDir, "ledger.jsonl");
  const events = await readEvents(eventsPath);
  const runId = events[0]?.runId ?? (path.basename(input.runDir) as ReportManifest["runId"]);
  const artifacts = extractArtifacts(events);
  const safeEventsResult = redactJsonValueWithSummary(events as unknown as import("./types.js").JsonValue);
  const safeEvents = safeEventsResult.value as unknown as CoreEvent[];
  const failures = safeEvents
    .filter((event) => event.type === "tool.call.failed")
    .map((event) => event.data as FailureCard | undefined)
    .filter((failure): failure is FailureCard => Boolean(failure));
  const reportId = createId("report");
  const artifactHashes = artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    relativePath: artifact.relativePath,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength
  }));
  const narrative = failures.length
    ? failures
        .map((failure) => `${failure.toolName}: ${failure.failureType}. ${failure.likelyRootCause}`)
        .join("\n")
    : "No failures were recorded for this run.";
  const remediationSteps = failures.flatMap((failure) => [...failure.safeRecoveryOptions, failure.humanFix ?? ""]);
  const safeNarrative = redactStringWithSummary(narrative);
  const safeRemediation = redactStringWithSummary(remediationSteps.filter(Boolean).join("\n"));
  const redactionSummary = {
    redactionCount: safeEventsResult.count + safeNarrative.count + safeRemediation.count,
    reasons: [...new Set([...safeEventsResult.reasons, ...safeNarrative.reasons, ...safeRemediation.reasons])]
  };
  const ledgerHash = await hashOptionalFile(ledgerPath);

  const manifest: ReportManifest = {
    reportId,
    runId,
    generatedAt: new Date().toISOString(),
    eventFile: "events.jsonl",
    reportFile: "report.html",
    artifactHashFile: "artifact-hashes.json",
    redactionSummaryFile: "redaction-summary.json",
    ...(ledgerHash ? { ledgerFile: "ledger.jsonl", ledgerSha256: ledgerHash } : {}),
    artifacts,
    redactionSummary
  };

  const reportHtml = renderReportHtml({
    reportId,
    runId,
    failures,
    narrative: safeNarrative.value,
    remediation: safeRemediation.value,
    artifacts
  });

  const reportPath = path.join(input.runDir, "report.html");
  const manifestPath = path.join(input.runDir, "manifest.json");
  const artifactHashPath = path.join(input.runDir, "artifact-hashes.json");
  const redactionSummaryPath = path.join(input.runDir, "redaction-summary.json");
  await writeFile(reportPath, reportHtml, "utf8");
  await writeFile(
    manifestPath,
    `${JSON.stringify(redactJsonValue(manifest as unknown as import("./types.js").JsonValue), null, 2)}\n`,
    "utf8"
  );
  await writeFile(artifactHashPath, `${JSON.stringify(artifactHashes, null, 2)}\n`, "utf8");
  await writeFile(redactionSummaryPath, `${JSON.stringify(redactionSummary, null, 2)}\n`, "utf8");

  return { reportId, reportPath, manifestPath, artifactHashPath, redactionSummaryPath };
}

export async function validateReportManifest(input: { readonly runDir: string }): Promise<ManifestValidationResult> {
  const errors: string[] = [];
  const manifestPath = path.join(input.runDir, "manifest.json");
  let manifest: ReportManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ReportManifest;
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : "manifest read failed"] };
  }

  for (const file of [
    manifest.eventFile,
    manifest.reportFile,
    manifest.artifactHashFile,
    manifest.redactionSummaryFile,
    ...(manifest.ledgerFile ? [manifest.ledgerFile] : [])
  ]) {
    try {
      await readFile(path.join(input.runDir, file), "utf8");
    } catch {
      errors.push(`Missing manifest file reference: ${file}`);
    }
  }

  if (manifest.ledgerFile && manifest.ledgerSha256) {
    try {
      const content = await readFile(path.join(input.runDir, manifest.ledgerFile), "utf8");
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (sha256 !== manifest.ledgerSha256) {
        errors.push("Hash mismatch for side-effect ledger");
      }
    } catch {
      errors.push(`Missing side-effect ledger: ${manifest.ledgerFile}`);
    }
  }

  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(input.runDir, artifact.relativePath);
    try {
      const content = await readFile(artifactPath, "utf8");
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (sha256 !== artifact.sha256) {
        errors.push(`Hash mismatch for artifact ${artifact.artifactId}`);
      }
    } catch {
      errors.push(`Missing artifact ${artifact.artifactId}: ${artifact.relativePath}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

async function hashOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return undefined;
  }
}

async function readEvents(eventsPath: string): Promise<CoreEvent[]> {
  const text = await readFile(eventsPath, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CoreEvent);
}

function extractArtifacts(events: readonly CoreEvent[]): EvidenceArtifact[] {
  return events
    .filter((event) => event.type === "evidence.artifact.created")
    .map((event) => event.data as EvidenceArtifact | undefined)
    .filter((artifact): artifact is EvidenceArtifact => Boolean(artifact?.artifactId));
}

function renderReportHtml(input: {
  readonly reportId: string;
  readonly runId: string;
  readonly failures: readonly FailureCard[];
  readonly narrative: string;
  readonly remediation: string;
  readonly artifacts: readonly EvidenceArtifact[];
}): string {
  const failureItems = input.failures
    .map(
      (failure) => `<li><strong>${escapeHtml(failure.toolName)}</strong>: ${escapeHtml(failure.failureType)}
        <p>${escapeHtml(failure.safeSummary)}</p>
      </li>`
    )
    .join("");
  const artifactRows = input.artifacts
    .map(
      (artifact) =>
        `<tr><td>${escapeHtml(artifact.artifactId)}</td><td>${escapeHtml(artifact.kind)}</td><td>${escapeHtml(
          artifact.relativePath
        )}</td><td>${escapeHtml(artifact.sha256)}</td></tr>`
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ToolGuard Evidence Report</title>
  <style>
    body{margin:0;background:#0c1018;color:#edf2ff;font-family:Inter,ui-sans-serif,system-ui,sans-serif;line-height:1.5}
    main{max-width:980px;margin:0 auto;padding:32px}
    section{border:1px solid #273247;border-radius:16px;padding:20px;margin:18px 0;background:#121927}
    code,pre{background:#080b12;border-radius:8px;padding:2px 6px}
    table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #273247;padding:8px;text-align:left}
  </style>
</head>
<body>
  <main>
    <h1>ToolGuard Evidence Report</h1>
    <p>Report <code>${escapeHtml(input.reportId)}</code> for run <code>${escapeHtml(input.runId)}</code>.</p>
    <section><h2>Failure narrative</h2><pre>${escapeHtml(input.narrative)}</pre></section>
    <section><h2>Remediation steps</h2><pre>${escapeHtml(input.remediation)}</pre></section>
    <section><h2>Failure Cards</h2><ul>${failureItems}</ul></section>
    <section><h2>Artifact hashes</h2><table><thead><tr><th>ID</th><th>Kind</th><th>Path</th><th>SHA-256</th></tr></thead><tbody>${artifactRows}</tbody></table></section>
  </main>
</body>
</html>
`;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
