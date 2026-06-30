import { writeFile } from "node:fs/promises";
import path from "node:path";
import { redactStringWithSummary } from "./redaction.js";
import type { CoreEvent } from "./events.js";
import type {
  EvidenceArtifact,
  EvidenceLink,
  FailureCard,
  IssuePacketExport,
  SideEffectLedgerEntry,
  TriageFailureGroup,
  TriagePayload,
  TriageQuestionAnswer,
  TriageSeverity,
  TriageState
} from "./types.js";
import type { StableId } from "./ids.js";

export function buildTriagePayload(input: {
  readonly runId: StableId;
  readonly events: readonly CoreEvent[];
  readonly ledger: readonly SideEffectLedgerEntry[];
  readonly baseUrl: string;
}): TriagePayload {
  const baseUrl = safeLoopbackBaseUrl(input.baseUrl);
  const failedEvents = input.events.filter((event) => event.type === "tool.call.failed" && isFailureCard(event.data));
  const groupsByFingerprint = new Map<string, CoreEvent[]>();
  for (const event of failedEvents) {
    const card = event.data as FailureCard;
    const fingerprint = failureFingerprint(card);
    groupsByFingerprint.set(fingerprint, [...(groupsByFingerprint.get(fingerprint) ?? []), event]);
  }
  const groups = [...groupsByFingerprint.entries()]
    .map(([fingerprint, events]) => buildTriageGroup({ fingerprint, events, ledger: input.ledger, runId: input.runId, baseUrl }))
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || right.lastOccurrence.localeCompare(left.lastOccurrence));

  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    groups,
    summary: {
      groups: groups.length,
      failures: failedEvents.length,
      critical: groups.filter((group) => group.severity === "critical").length,
      high: groups.filter((group) => group.severity === "high").length,
      medium: groups.filter((group) => group.severity === "medium").length,
      low: groups.filter((group) => group.severity === "low").length
    },
    states: unique(groups.map((group) => group.state)),
    links: {
      topology: link("topology", "Topology graph", `${baseUrl}/api/topology/${encodeURIComponent(input.runId)}`),
      timeline: link("timeline", "Timeline events", `${baseUrl}/api/runs/latest`),
      evidenceBundle: link("evidence-bundle", "Evidence bundle", `${baseUrl}/api/bundle`)
    }
  };
}

export async function exportIssuePacket(input: {
  readonly runId: StableId;
  readonly runDir: string;
  readonly events: readonly CoreEvent[];
  readonly ledger: readonly SideEffectLedgerEntry[];
  readonly baseUrl: string;
}): Promise<IssuePacketExport> {
  const triage = buildTriagePayload(input);
  const markdown = buildIssuePacketMarkdown(triage);
  const redacted = redactStringWithSummary(markdown);
  assertContainedIssuePacketLinks(redacted.value);
  const issuePacketPath = path.join(input.runDir, "issue-packet.md");
  await writeFile(issuePacketPath, `${redacted.value}\n`, "utf8");
  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    issuePacketPath,
    issuePacketUrl: `${safeLoopbackBaseUrl(input.baseUrl)}/api/triage/issue-packet`,
    markdown: redacted.value,
    noSecretFindings: findSecretPatterns(redacted.value),
    containedLinks: true,
    groups: triage.groups.map((group) => group.fingerprint)
  };
}

function buildTriageGroup(input: {
  readonly fingerprint: string;
  readonly events: readonly CoreEvent[];
  readonly ledger: readonly SideEffectLedgerEntry[];
  readonly runId: StableId;
  readonly baseUrl: string;
}): TriageFailureGroup {
  const last = [...input.events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)).at(-1);
  const card = last?.data as FailureCard;
  const relatedLedger = input.ledger.filter((entry) => input.events.some((event) => event.toolCallId === entry.toolCallId || event.traceId === entry.traceId));
  const evidenceLinks = safeEvidenceLinks(card.evidenceLinks, input.runId, input.baseUrl);
  const topologyLinks = [
    link("topology", "Topology node links", `${input.baseUrl}/api/topology/${encodeURIComponent(input.runId)}`)
  ];
  const timelineLinks = input.events.map((event) => link(event.eventId, `Timeline event ${event.eventId}`, `${input.baseUrl}/api/runs/latest#${encodeURIComponent(event.eventId)}`));
  const rawArtifactLabels = evidenceLinks.map((evidence) => `${evidence.label}: ${evidence.artifactId}`);
  const severityResult = assignSeverity(card, input.events, relatedLedger);
  const nextSafeActions = buildNextSafeActions(card, severityResult.severity, relatedLedger);
  const answers: TriageQuestionAnswer[] = [
    {
      question: "what failed",
      answer: `${card.toolName} failed with ${card.failureType}. ${card.safeSummary}`,
      evidence: evidenceLinks
    },
    {
      question: "why",
      answer: `${card.likelyRootCause} ${card.failureMechanism}`,
      evidence: evidenceLinks
    },
    {
      question: "impact",
      answer: impactAnswer(card, relatedLedger),
      evidence: topologyLinks
    },
    {
      question: "waste",
      answer: wasteAnswer(card, input.events.length),
      evidence: timelineLinks
    },
    {
      question: "next safe action",
      answer: nextSafeActions[0] ?? "Review contained evidence before retrying.",
      evidence: evidenceLinks
    }
  ];
  const state: TriageState = input.events.length > 1 ? "grouped" : severityResult.severity === "critical" || severityResult.severity === "high" ? "ready-to-file" : "new";
  return {
    fingerprint: input.fingerprint,
    count: input.events.length,
    lastOccurrence: last?.occurredAt ?? new Date(0).toISOString(),
    severity: severityResult.severity,
    state,
    toolName: card.toolName,
    failureType: card.failureType,
    title: `${severityResult.severity.toUpperCase()} ${card.toolName} ${card.failureType}`,
    summary: card.safeSummary,
    answers,
    nextSafeActions,
    topologyLinks,
    timelineLinks,
    evidenceLinks,
    rawArtifactLabels,
    issuePacketPreview: buildGroupIssueMarkdown(input.runId, input.fingerprint, {
      fingerprint: input.fingerprint,
      count: input.events.length,
      lastOccurrence: last?.occurredAt ?? new Date(0).toISOString(),
      severity: severityResult.severity,
      state,
      toolName: card.toolName,
      failureType: card.failureType,
      title: `${severityResult.severity.toUpperCase()} ${card.toolName} ${card.failureType}`,
      summary: card.safeSummary,
      answers,
      nextSafeActions,
      topologyLinks,
      timelineLinks,
      evidenceLinks,
      rawArtifactLabels,
      issuePacketPreview: "",
      factors: severityResult.factors
    }),
    factors: severityResult.factors
  };
}

function failureFingerprint(card: FailureCard): string {
  return [
    card.toolName,
    card.failureType,
    card.failureCause,
    card.failureBoundary
  ].join(":");
}

function assignSeverity(
  card: FailureCard,
  events: readonly CoreEvent[],
  ledger: readonly SideEffectLedgerEntry[]
): { readonly severity: TriageSeverity; readonly factors: readonly string[] } {
  const factors: string[] = [];
  let score = 0;
  if (card.failureType === "destructive_action_blocked" || card.failureType === "policy_blocked") {
    score += 4;
    factors.push("destructive block or policy block");
  }
  if (card.failureType === "secret_leak_risk") {
    score += 4;
    factors.push("secret redaction risk");
  }
  if (card.retryLoopFinding?.classification === "loop-detected" || events.length > 1 || card.contextImpact.duplicateRetryContext.repeatedFingerprintCount > 1) {
    score += 3;
    factors.push("repeated failure fingerprint or retry loop");
  }
  if (ledger.some((entry) => entry.effectState === "unknown" || entry.reversibility === "irreversible-risk" || entry.blastRadius.label === "workspace-risk" || entry.blastRadius.label === "system-risk")) {
    score += 3;
    factors.push("suspected side effect or unknown impact");
  }
  if (card.doNotRetrySameCall) {
    score += 1;
    factors.push("same-call retry suppressed");
  }
  if (factors.length === 0) factors.push("contained single failure");
  if (score >= 7) return { severity: "critical", factors };
  if (score >= 4) return { severity: "high", factors };
  if (score >= 2) return { severity: "medium", factors };
  return { severity: "low", factors };
}

function buildNextSafeActions(
  card: FailureCard,
  severity: TriageSeverity,
  ledger: readonly SideEffectLedgerEntry[]
): readonly string[] {
  const actions = [...card.safeRecoveryOptions];
  if (card.doNotRetrySameCall) actions.unshift("Do not retry the identical call until inputs, cwd, policy, or downstream health are changed.");
  if (severity === "critical" || severity === "high") actions.push("Export this issue packet and attach contained local evidence links before handoff.");
  if (ledger.some((entry) => entry.observedImpact?.rollbackGuidance.length)) {
    actions.push("Review observed-impact rollback guidance before replaying.");
  }
  actions.push("Use fixture-only replay or safe loopback evidence if reproducing locally.");
  return unique(actions);
}

function impactAnswer(card: FailureCard, ledger: readonly SideEffectLedgerEntry[]): string {
  if (ledger.length === 0) {
    return card.sideEffectSummary ?? "No side-effect ledger rows are linked to this failure; impact is currently unknown or contained by policy.";
  }
  return ledger.map((entry) => `${entry.effectState} ${entry.targetType}, blast radius ${entry.blastRadius.label} (${entry.blastRadius.score}). ${entry.causalClaim}`).join(" ");
}

function wasteAnswer(card: FailureCard, count: number): string {
  const duplicate = card.contextImpact.duplicateRetryContext;
  const saved = card.contextImpact.preventedContextFlood.saved;
  return `${count} occurrence(s), ${duplicate.estimatedDuplicateTokens} duplicate estimated tokens, ${saved.estimatedTokens} estimated tokens prevented from raw context flood.`;
}

function safeEvidenceLinks(links: readonly EvidenceLink[], runId: StableId, baseUrl: string): readonly EvidenceLink[] {
  return links.map((linkItem) => link(linkItem.artifactId, linkItem.label, `${baseUrl}/api/reports/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(linkItem.artifactId)}`));
}

function buildIssuePacketMarkdown(payload: TriagePayload): string {
  const lines = [
    `# ToolGuard issue packet for ${payload.runId}`,
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    "## Summary",
    "",
    `Failures: ${payload.summary.failures}`,
    `Groups: ${payload.summary.groups}`,
    `Severity: ${payload.summary.critical} critical, ${payload.summary.high} high, ${payload.summary.medium} medium, ${payload.summary.low} low`,
    "",
    "## Contained local links",
    "",
    `- [Topology](${payload.links.topology.href})`,
    `- [Timeline](${payload.links.timeline.href})`,
    `- [Evidence bundle](${payload.links.evidenceBundle.href})`,
    ""
  ];
  for (const group of payload.groups) {
    lines.push(buildGroupIssueMarkdown(payload.runId, group.fingerprint, group), "");
  }
  return lines.join("\n");
}

function buildGroupIssueMarkdown(runId: StableId, fingerprint: string, group: TriageFailureGroup): string {
  return [
    `## ${group.title}`,
    "",
    `Fingerprint: \`${fingerprint}\``,
    `Count: ${group.count}`,
    `Last occurrence: ${group.lastOccurrence}`,
    `State: ${group.state}`,
    "",
    "### Diagnosis",
    "",
    ...group.answers.map((answer) => `- **${answer.question}:** ${answer.answer}`),
    "",
    "### Recommended fix / next safe actions",
    "",
    ...group.nextSafeActions.map((action) => `- ${action}`),
    "",
    "### Reproduction",
    "",
    `Run ID: \`${runId}\``,
    `Fingerprint: \`${fingerprint}\``,
    `Tool name: \`${group.toolName}\``,
    `Failure type: \`${group.failureType}\``,
    `Occurrence count: ${group.count}`,
    `Last occurrence: \`${group.lastOccurrence}\``,
    "",
    "- Replay only with fixture-only inputs or safe loopback evidence from this run.",
    "- Use the contained topology, timeline, and artifact links below to inspect the recorded failure before attempting any rerun.",
    "- Do not paste raw artifacts, credentials, or external URLs into reproduction notes.",
    "",
    "### Evidence links",
    "",
    ...[...group.topologyLinks, ...group.timelineLinks, ...group.evidenceLinks].map((evidence) => `- [${evidence.label}](${evidence.href})`),
    "",
    "### Raw artifact labels",
    "",
    ...(group.rawArtifactLabels.length ? group.rawArtifactLabels.map((label) => `- ${label}`) : ["- No raw artifact labels linked to this group."]),
    "",
    "### Severity factors",
    "",
    ...group.factors.map((factor) => `- ${factor}`)
  ].join("\n");
}

function link(artifactId: string, label: string, href: string): EvidenceLink {
  return { artifactId: artifactId as StableId, label, href };
}

function unique<T extends string>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function severityRank(severity: TriageSeverity): number {
  if (severity === "critical") return 4;
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function isFailureCard(value: CoreEvent["data"]): value is FailureCard {
  return isRecord(value) && typeof value.toolName === "string" && typeof value.failureType === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isEvidenceArtifact(value: CoreEvent["data"]): value is EvidenceArtifact {
  return isRecord(value) && typeof value.artifactId === "string" && typeof value.kind === "string";
}

function findSecretPatterns(text: string): readonly string[] {
  const patterns: readonly [string, RegExp][] = [
    ["bearer-token", /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
    ["openai-key", /sk-[A-Za-z0-9]{12,}/],
    ["private-key", /-----BEGIN [A-Z ]+PRIVATE KEY-----/],
    ["api-key-assignment", /\b(api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i]
  ];
  return patterns.flatMap(([label, pattern]) => (pattern.test(text) ? [label] : []));
}

function safeLoopbackBaseUrl(candidate: string): string {
  try {
    const parsed = new URL(candidate);
    const port = Number(parsed.port || (parsed.protocol === "http:" ? "80" : "443"));
    const isLoopback = parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    const isApprovedPort = port >= 3660 && port <= 3669;
    if (isLoopback && isApprovedPort) return parsed.origin;
  } catch {
    // Fall through to the approved local Core/API surface.
  }
  return "http://127.0.0.1:3660";
}

function assertContainedIssuePacketLinks(markdown: string): void {
  const unsafeLinks = [...markdown.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((href): href is string => typeof href === "string")
    .filter((href) => !isApprovedLoopbackApiLink(href));
  if (unsafeLinks.length > 0) {
    throw new Error(`Issue packet contains unsafe external link(s): ${unsafeLinks.join(", ")}`);
  }
}

function isApprovedLoopbackApiLink(href: string): boolean {
  try {
    const parsed = new URL(href);
    const port = Number(parsed.port || (parsed.protocol === "http:" ? "80" : "443"));
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      port >= 3660 &&
      port <= 3669 &&
      parsed.pathname.startsWith("/api/")
    );
  } catch {
    return false;
  }
}
