import { CorrelationGrid } from "../components/CorrelationGrid.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import type { ImpactEntryView, ImpactPayload, ResourceStatus } from "../lib/model.js";

type ChipTone = "healthy" | "degraded" | "failed" | "warning" | "blocked" | "retry" | "neutral" | "selected";

interface ImpactPanelProps {
  readonly payload?: ImpactPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

export function ImpactPanel({ payload, status, error }: ImpactPanelProps) {
  if (status === "loading") {
    return <StatePanel status="loading" title="Loading observed impact" message="Fetching side-effect ledger rows and observed local impact from `/api/impact`." />;
  }
  if (status === "error") {
    return <StatePanel status="error" title="Impact panel unavailable" message={error ?? "Core did not return observed impact."} />;
  }
  if (!payload || payload.entries.length === 0) {
    return (
      <StatePanel
        status="empty"
        title="No observed impact yet"
        message="No side-effect ledger rows have been recorded for this run."
        action="Run a mediated CLI or fixture call to populate observed changes, process lifecycle, and rollback guidance."
      />
    );
  }

  const summaryCards = [
    { label: "Ledger rows", value: payload.summary.entries, note: "Attributed local impact records" },
    { label: "Observed changes", value: payload.summary.observedChanges, note: "Filesystem diffs from contained workspaces" },
    { label: "Safe affected paths", value: payload.summary.safeAffectedPaths, note: "Contained relative paths and artifact writes" },
    { label: "Process children", value: payload.summary.processChildren, note: "Captured process lifecycle records" },
    { label: "Rollback steps", value: payload.summary.rollbackSteps, note: "Human-safe recovery guidance" },
    { label: "Reversible rows", value: payload.summary.reversible, note: "Rows not marked irreversible-risk" }
  ];

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-primary/25 bg-[radial-gradient(circle_at_12%_0%,oklch(0.66_0.16_154_/_0.16),transparent_28rem),linear-gradient(135deg,oklch(0.18_0.03_260),oklch(0.11_0.02_260))] p-6">
        <div className="flex flex-wrap gap-2">
          <StatusChip label="Observed Impact" tone="selected" />
          <StatusChip label={`${payload.summary.blocked} blocked`} tone={payload.summary.blocked > 0 ? "blocked" : "neutral"} />
        </div>
        <h2 className="mt-3 text-3xl font-black tracking-[-0.035em] text-text">Observed local impact and rollback guidance</h2>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-text-muted">
          This panel lists measured file changes, contained safe paths, child process lifecycle facts, reversibility,
          attribution, and rollback guidance. It distinguishes observed facts from inferred or blocked impact.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Observed impact summary">
        {summaryCards.map((card) => (
          <article key={card.label} className="rounded-2xl border border-border bg-bg-panel/80 p-4">
            <p className="text-sm font-medium text-text-muted">{card.label}</p>
            <p className="mt-2 text-3xl font-semibold text-text">{card.value}</p>
            <p className="mt-1 text-sm leading-6 text-text-dim">{card.note}</p>
          </article>
        ))}
      </div>

      <div className="space-y-4">
        {payload.entries.map((entry) => (
          <ImpactEntryCard key={entry.ledgerId} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function ImpactEntryCard({ entry }: { readonly entry: ImpactEntryView }) {
  const impact = entry.observedImpact;
  const affectedPaths = impact?.safeAffectedPaths ?? [];
  const rollbackGuidance = impact?.rollbackGuidance ?? fallbackRollbackGuidance(entry);
  const process = impact?.processLifecycle;

  return (
    <article className="rounded-2xl border border-border bg-bg-panel/90 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            <StatusChip label={entry.effectState} tone={effectTone(entry.effectState)} />
            <StatusChip label={`Reversibility: ${entry.reversibility}`} tone={entry.reversibility === "irreversible-risk" ? "failed" : "healthy"} />
            <StatusChip label={`Attribution: ${entry.attributionLevel}`} tone={entry.attributionLevel === "unknown" ? "warning" : "selected"} />
            <StatusChip label={`Blast radius: ${entry.blastRadius.label}`} tone={blastTone(entry.blastRadius.label)} />
          </div>
          <h3 className="mt-3 text-xl font-semibold text-text">{entry.toolName}</h3>
          <p className="mt-2 text-sm leading-6 text-text-muted">{entry.summary}</p>
        </div>
        <time className="font-mono text-xs text-text-dim">{entry.recordedAt}</time>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-xl border border-border bg-bg/55 p-4">
          <h4 className="text-sm font-semibold text-text">Observed changes and safe affected paths</h4>
          {impact?.fileChanges.length ? (
            <ul className="mt-3 space-y-2">
              {impact.fileChanges.map((change) => (
                <li key={`${entry.ledgerId}-${change.path}`} className="rounded-lg border border-border bg-bg-panel/70 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip label={change.changeType} tone={change.changeType === "deleted" ? "failed" : "warning"} />
                    <span className="break-all font-mono text-xs text-primary">{change.path}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-text-dim">
                    Before {describeMetadata(change.before)}. After {describeMetadata(change.after)}.
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm leading-6 text-text-muted">No filesystem diff was observed for this row.</p>
          )}
          {affectedPaths.length > 0 ? (
            <div className="mt-4">
              <p className="text-xs uppercase tracking-[0.2em] text-text-dim">Safe affected paths</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {affectedPaths.map((safePath) => (
                  <span key={safePath} className="break-all rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-primary">
                    {safePath}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-border bg-bg/55 p-4">
          <h4 className="text-sm font-semibold text-text">Process children</h4>
          {process ? (
            <dl className="mt-3 grid gap-2 text-sm">
              <Fact label="pid" value={process.pid ?? "none"} />
              <Fact label="processGroupId" value={process.processGroupId ?? "none"} />
              <Fact label="exitCode" value={process.exitCode ?? "none"} />
              <Fact label="signal" value={process.signal ?? "none"} />
              <Fact label="cleanup" value={process.cleanupResult} />
              <Fact label="timedOut" value={String(process.timedOut)} />
              <Fact label="cancelled" value={String(process.cancelled)} />
            </dl>
          ) : (
            <p className="mt-3 text-sm leading-6 text-text-muted">No child process lifecycle was captured for this row.</p>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <InfoBlock title="Attribution basis" body={`${entry.causalClaim} Evidence: ${entry.evidenceBasis.join(", ")}.`} />
        <InfoBlock title="Counter evidence" body={entry.counterEvidence.length > 0 ? entry.counterEvidence.join(" ") : "No counter-evidence recorded."} />
        <div className="rounded-xl border border-border bg-bg/55 p-4">
          <h4 className="text-sm font-semibold text-text">Rollback guidance</h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-muted">
            {rollbackGuidance.map((guidance) => (
              <li key={guidance}>{guidance}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-border bg-bg/55 p-4">
          <h4 className="text-sm font-semibold text-text">Bundle hashes</h4>
          {impact?.bundleHashes.length ? (
            <ul className="mt-2 space-y-2">
              {impact.bundleHashes.map((hash) => (
                <li key={`${hash.relativePath}-${hash.sha256}`} className="break-all font-mono text-xs text-text-muted">
                  {hash.relativePath}: {hash.sha256} ({hash.byteLength} bytes)
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-text-muted">No impact bundle hash attached to this row.</p>
          )}
        </div>
      </div>

      <div className="mt-5">
        <h4 className="mb-2 text-sm font-semibold text-text">Correlation IDs</h4>
        <CorrelationGrid
          correlation={{
            runId: entry.runId,
            traceId: entry.traceId,
            toolCallId: entry.toolCallId,
            attemptId: entry.attemptId,
            policyDecisionId: entry.policyDecisionId
          }}
        />
      </div>
    </article>
  );
}

function fallbackRollbackGuidance(entry: ImpactEntryView): readonly string[] {
  if (entry.effectState === "blocked") return ["No rollback required. ToolGuard blocked the action before downstream execution."];
  if (entry.reversibility === "irreversible-risk") return ["Do not replay automatically. Review separated evidence and restore from a trusted backup if mutation is confirmed."];
  return ["No observed workspace file changes require rollback."];
}

function Fact({ label, value }: { readonly label: string; readonly value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-panel/70 px-3 py-2">
      <dt className="text-xs uppercase tracking-[0.18em] text-text-dim">{label}</dt>
      <dd className="font-mono text-xs text-primary">{value}</dd>
    </div>
  );
}

function InfoBlock({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg/55 p-4">
      <h4 className="text-sm font-semibold text-text">{title}</h4>
      <p className="mt-2 text-sm leading-6 text-text-muted">{body}</p>
    </div>
  );
}

function describeMetadata(metadata: { readonly type: string; readonly sizeBytes: number } | undefined): string {
  return metadata ? `${metadata.type}, ${metadata.sizeBytes} bytes` : "not present";
}

function effectTone(effectState: string): ChipTone {
  if (effectState === "blocked") return "blocked";
  if (effectState === "completed" || effectState === "simulated") return "healthy";
  if (effectState === "unknown") return "warning";
  return "neutral";
}

function blastTone(label: string): ChipTone {
  if (label === "system-risk" || label === "workspace-risk") return "warning";
  if (label === "limited") return "degraded";
  return "healthy";
}
