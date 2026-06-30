import { useState } from "react";
import { exportIssuePacket } from "../lib/api.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import type { FailureTriagePayload, ResourceStatus } from "../lib/model.js";

interface FailureTriageProps {
  readonly payload?: FailureTriagePayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

export function FailureTriage({ payload, status, error }: FailureTriageProps) {
  const [exportState, setExportState] = useState<"idle" | "loading" | "done" | "error">("idle");

  if (status === "loading") {
    return <StatePanel status="loading" title="Loading Diagnosis / Incident triage" message="Fetching grouped failure fingerprints and safe issue export state from `/api/triage`." />;
  }
  if (status === "error") {
    return <StatePanel status="error" title="Diagnosis unavailable" message={error ?? "Core did not return triage data."} />;
  }
  if (status === "degraded" && !payload) {
    return <StatePanel status="degraded" title="Diagnosis partially unavailable" message={error ?? "Some Core endpoints are unavailable. Triage will recover when failure, impact, and evidence data return."} />;
  }
  if (!payload || payload.groups.length === 0) {
    return (
      <StatePanel
        status="empty"
        title="No incidents to triage"
        message="No failed ToolGuard run has produced a diagnosis group yet."
        action="Run a failing mediated fixture to populate what failed, why, impact, waste, and next safe action."
      />
    );
  }

  async function handleExport() {
    setExportState("loading");
    try {
      await exportIssuePacket();
      setExportState("done");
    } catch {
      setExportState("error");
    }
  }

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-primary/25 bg-[radial-gradient(circle_at_16%_0%,oklch(0.66_0.16_27_/_0.18),transparent_26rem),linear-gradient(135deg,oklch(0.19_0.035_260),oklch(0.11_0.02_260))] p-6">
        <div className="flex flex-wrap gap-2">
          <StatusChip label="Diagnosis / Incident" tone="selected" />
          <StatusChip label={`${payload.summary.failures} failures`} tone="failed" />
          <StatusChip label={`${payload.summary.groups} fingerprints`} tone="degraded" />
          <StatusChip label={`${payload.summary.critical + payload.summary.high} high severity`} tone={payload.summary.critical + payload.summary.high > 0 ? "warning" : "neutral"} />
        </div>
        <div className="mt-4 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h2 className="text-3xl font-black tracking-[-0.035em] text-text">Failure triage that answers the incident questions</h2>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-text-muted">
              Repeated failures are grouped by fingerprint, severity is assigned from blocked work, retry loops,
              side-effect uncertainty, secret redaction, and destructive blocks, then each group links to topology,
              timeline, raw artifact labels, and the evidence bundle.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exportState === "loading"}
            className="min-h-11 rounded-xl border border-primary/50 bg-primary/15 px-4 py-3 text-sm font-semibold text-primary transition hover:bg-primary/25 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"
          >
            {exportState === "loading" ? "Exporting safe issue packet..." : exportState === "done" ? "Issue packet exported" : "Export safe Markdown issue packet"}
          </button>
        </div>
        {exportState === "error" ? <p className="mt-3 text-sm font-semibold text-danger">Issue packet export failed. Check Core API logs and retry.</p> : null}
      </div>

      {status === "degraded" ? (
        <StatePanel status="degraded" title="Triage using partial data" message={error ?? "One supporting endpoint failed, but the diagnosis payload is available."} />
      ) : null}

      <div className="grid gap-3 md:grid-cols-4" aria-label="Triage state summary">
        <SummaryCard label="Critical" value={payload.summary.critical} tone="failed" />
        <SummaryCard label="High" value={payload.summary.high} tone="warning" />
        <SummaryCard label="Grouped states" value={payload.states.length} tone="selected" />
        <SummaryCard label="Contained links" value={3} tone="healthy" />
      </div>

      <div className="grid gap-3 lg:grid-cols-3" aria-label="Global triage links">
        <LinkCard label="Topology" href={payload.links.topology.href} />
        <LinkCard label="Timeline" href={payload.links.timeline.href} />
        <LinkCard label="Evidence bundle" href={payload.links.evidenceBundle.href} />
      </div>

      <div className="space-y-4">
        {payload.groups.map((group) => (
          <article key={group.fingerprint} className={`rounded-2xl border p-5 shadow-2xl shadow-black/20 ${group.severity === "critical" || group.severity === "high" ? "border-danger/45 bg-danger/10" : "border-border bg-bg-panel/90"}`}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap gap-2">
                  <StatusChip label={`Severity: ${group.severity}`} tone={severityTone(group.severity)} />
                  <StatusChip label={`State: ${group.state}`} tone="selected" />
                  <StatusChip label={`${group.count} occurrence${group.count === 1 ? "" : "s"}`} tone={group.count > 1 ? "retry" : "neutral"} />
                </div>
                <h3 className="mt-3 text-xl font-semibold text-text">{group.title}</h3>
                <p className="mt-2 break-all font-mono text-xs text-text-dim">{group.fingerprint}</p>
              </div>
              <time className="font-mono text-xs text-text-dim">{group.lastOccurrence}</time>
            </div>

            <div className="mt-5 grid gap-3 xl:grid-cols-5" aria-label="Five diagnosis answers">
              {group.answers.map((answer) => (
                <section key={`${group.fingerprint}-${answer.question}`} className="rounded-xl border border-border bg-bg/60 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-dim">{answer.question}</p>
                  <p className="mt-2 text-sm leading-6 text-text-muted">{answer.answer}</p>
                </section>
              ))}
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <section className="rounded-xl border border-border bg-bg/60 p-4">
                <h4 className="text-sm font-semibold text-text">Next safe actions</h4>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-muted">
                  {group.nextSafeActions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ul>
              </section>
              <section className="rounded-xl border border-border bg-bg/60 p-4">
                <h4 className="text-sm font-semibold text-text">Severity factors</h4>
                <div className="mt-2 flex flex-wrap gap-2">
                  {group.factors.map((factor) => (
                    <StatusChip key={factor} label={factor} tone="warning" />
                  ))}
                </div>
              </section>
            </div>

            <div className="mt-5 grid gap-3 lg:grid-cols-3">
              <EvidenceList title="Topology links" links={group.topologyLinks} />
              <EvidenceList title="Timeline links" links={group.timelineLinks} />
              <EvidenceList title="Evidence links" links={group.evidenceLinks} />
            </div>

            <div className="mt-5 rounded-xl border border-border bg-bg p-4">
              <h4 className="text-sm font-semibold text-text">Raw artifact labels and safe issue preview</h4>
              <div className="mt-3 grid gap-3 lg:grid-cols-[0.8fr_1.2fr]">
                <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
                  {group.rawArtifactLabels.length > 0 ? group.rawArtifactLabels.map((label) => <li key={label}>{label}</li>) : <li>No raw artifact labels linked.</li>}
                </ul>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg-panel/80 p-3 text-xs leading-5 text-text-muted">{group.issuePacketPreview}</pre>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SummaryCard({ label, value, tone }: { readonly label: string; readonly value: number; readonly tone: "healthy" | "failed" | "warning" | "selected" }) {
  return (
    <article className="rounded-2xl border border-border bg-bg-panel/80 p-4">
      <StatusChip label={label} tone={tone} />
      <p className="mt-3 text-3xl font-black text-text">{value}</p>
    </article>
  );
}

function LinkCard({ label, href }: { readonly label: string; readonly href: string }) {
  return (
    <a href={href} className="rounded-xl border border-border bg-bg-panel/80 p-4 text-sm font-semibold text-primary transition hover:border-primary/50 hover:bg-primary/10 focus-visible:border-primary">
      {label}: <span className="break-all font-mono text-xs">{href}</span>
    </a>
  );
}

function EvidenceList({ title, links }: { readonly title: string; readonly links: readonly { readonly artifactId: string; readonly href: string; readonly label: string }[] }) {
  return (
    <section className="rounded-xl border border-border bg-bg/60 p-4">
      <h4 className="text-sm font-semibold text-text">{title}</h4>
      <div className="mt-2 space-y-2">
        {links.map((link) => (
          <a key={`${title}-${link.artifactId}`} href={link.href} className="block break-all rounded-lg border border-border bg-bg-panel/70 p-2 font-mono text-xs text-primary hover:border-primary/50 focus-visible:border-primary">
            {link.label}: {link.artifactId}
          </a>
        ))}
      </div>
    </section>
  );
}

function severityTone(severity: string): "healthy" | "degraded" | "failed" | "warning" {
  if (severity === "critical") return "failed";
  if (severity === "high") return "warning";
  if (severity === "medium") return "degraded";
  return "healthy";
}
