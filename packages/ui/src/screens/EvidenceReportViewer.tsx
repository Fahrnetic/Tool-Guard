import { useState } from "react";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import { exportReport, fetchReports } from "../lib/api.js";
import { selectionMatchesValues, type ReportView, type ReportsPayload, type ResourceStatus, type TopologySelection } from "../lib/model.js";

interface EvidenceReportViewerProps {
  readonly payload?: ReportsPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
  readonly topologySelection?: TopologySelection;
}

export function EvidenceReportViewer({ payload, status, error, topologySelection }: EvidenceReportViewerProps) {
  const [reports, setReports] = useState<ReportsPayload | undefined>(payload);
  const [exportState, setExportState] = useState<"idle" | "pending" | "success" | "failure">("idle");
  const [exportMessage, setExportMessage] = useState<string | undefined>();
  const activePayload = reports ?? payload;
  const report = activePayload?.reports[0];

  async function generateReport() {
    setExportState("pending");
    setExportMessage("Generating report.html, manifest.json, artifact hashes, and redaction summary.");
    try {
      const exported = await exportReport();
      const next = await fetchReports();
      setReports(next);
      setExportState("success");
      setExportMessage(`Created ${exported.reportUrl} and ${exported.manifestUrl}. Manifest valid: ${String(exported.manifestValid)}.`);
    } catch (caught) {
      setExportState("failure");
      setExportMessage(caught instanceof Error ? caught.message : String(caught));
    }
  }

  if (status === "loading") {
    return <StatePanel status="loading" title="Loading Evidence Report Viewer" message="Fetching report manifests, artifact hashes, redaction summaries, narratives, and remediation." />;
  }
  if (status === "error") {
    return <StatePanel status="error" title="Evidence reports unavailable" message={error ?? "Core did not return report metadata."} />;
  }

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <StatusChip label="Evidence Report Viewer" tone="selected" />
            <h2 className="mt-3 text-2xl font-semibold text-text">Reports, manifests, artifact hashes, and redaction proof</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
              Export and inspect browser-safe static reports while keeping secret-shaped values redacted in UI previews.
              Raw artifacts stay linked by metadata, hashes, and intentional local links.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void generateReport()}
            disabled={exportState === "pending"}
            aria-busy={exportState === "pending"}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-primary/50 bg-primary/15 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exportState === "pending" ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" /> : null}
            {exportState === "pending" ? "Export pending..." : "Generate or refresh report"}
          </button>
        </div>
      </div>

      {status === "degraded" ? (
        <StatePanel status="degraded" title="Partial report metadata" message="Some Core endpoints failed, but report links and artifact metadata remain inspectable." />
      ) : null}
      {exportState !== "idle" ? (
        <StatePanel
          status={exportState === "pending" ? "loading" : exportState === "success" ? "ready" : "error"}
          title={exportState === "success" ? "Report export succeeded" : exportState === "failure" ? "Report export failed" : "Report export running"}
          message={exportMessage ?? "Report action state changed."}
        />
      ) : null}
      {!report || !report.exists ? (
        <StatePanel
          status="empty"
          title="No exported report yet"
          message="Generate a report to create report.html, manifest.json, artifact-hashes.json, and redaction-summary.json."
          action="The action above calls `/api/reports/export` and then refreshes `/api/reports`."
        />
      ) : null}

      {report ? <ReportCard report={report} {...(topologySelection ? { topologySelection } : {})} /> : null}
    </section>
  );
}

function ReportCard({ report, topologySelection }: { readonly report: ReportView; readonly topologySelection?: TopologySelection }) {
  return (
    <article className="space-y-5 rounded-2xl border border-border bg-bg-panel/90 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            <StatusChip label={report.exists ? "exported" : "not exported"} tone={report.exists ? "healthy" : "degraded"} />
            <StatusChip label={report.manifestValid ? "manifest valid" : "manifest needs attention"} tone={report.manifestValid ? "healthy" : "failed"} />
            <StatusChip label={`${report.artifactCount} artifacts`} tone="neutral" />
            <StatusChip label={`${report.redactionSummary.redactionCount} redactions`} tone={report.redactionSummary.redactionCount > 0 ? "degraded" : "neutral"} />
          </div>
          <h3 className="mt-3 text-xl font-semibold text-text">Run {report.runId}</h3>
          <p className="mt-1 text-sm text-text-muted">Generated {report.generatedAt}</p>
        </div>
        <div className="grid gap-2 text-sm">
          <LocalLink href={report.reportUrl} label="Open local report.html" path={report.reportUrl} />
          <LocalLink href={report.manifestUrl} label="Open manifest.json" path={report.manifestUrl} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <PreviewBlock title="Failure narrative, sanitized preview" body={redactedPreview(report.narrative)} />
        <PreviewBlock title="Remediation steps" body={redactedPreview(report.remediation)} />
        <PreviewBlock
          title="Redaction proof"
          body={`${report.redactionSummary.redactionCount} redactions\n${
            report.redactionSummary.reasons.join("\n") || "No secret-shaped values appeared in this safe preview."
          }\nBearer [REDACTED]\napi_key=[REDACTED]\n[REDACTED_PEM]`}
        />
        <PreviewBlock title="Manifest validation" body={report.validationErrors.length > 0 ? report.validationErrors.join("\n") : "Manifest references resolved and artifact hashes validated."} />
      </div>

      <section className="rounded-xl border border-border bg-bg/55 p-4">
        <h4 className="text-sm font-semibold text-text">Artifact and manifest links</h4>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <LocalLink href={report.artifactHashUrl} label="Open artifact-hashes.json" path={report.artifactHashUrl} />
          <LocalLink href={report.redactionSummaryUrl} label="Open redaction-summary.json" path={report.redactionSummaryUrl} />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-bg/55 p-4">
        <h4 className="text-sm font-semibold text-text">Artifact metadata and hashes</h4>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-[860px] w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.16em] text-text-dim">
              <tr>
                <th className="border-b border-border px-3 py-2">Artifact</th>
                <th className="border-b border-border px-3 py-2">Kind</th>
                <th className="border-b border-border px-3 py-2">Path</th>
                <th className="border-b border-border px-3 py-2">SHA-256</th>
                <th className="border-b border-border px-3 py-2">Redacted</th>
              </tr>
            </thead>
            <tbody>
              {report.artifacts.map((artifact) => {
                const hash = report.artifactHashes.find((item) => item.artifactId === artifact.artifactId);
                const highlighted = selectionMatchesValues(topologySelection, [artifact.artifactId, artifact.relativePath, hash?.artifactId]);
                return (
                  <tr key={artifact.artifactId} className={`hover:bg-primary/5 ${highlighted ? "bg-primary/10" : ""}`}>
                    <td className="border-b border-border/70 px-3 py-2 font-mono text-xs">
                      <a href={artifact.artifactUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        {artifact.artifactId}
                      </a>
                    </td>
                    <td className="border-b border-border/70 px-3 py-2"><StatusChip label={artifact.kind} tone="neutral" /></td>
                    <td className="border-b border-border/70 px-3 py-2 font-mono text-xs text-text-muted">{artifact.relativePath}</td>
                    <td className="border-b border-border/70 px-3 py-2 font-mono text-xs text-text-muted">{hash?.sha256 ?? artifact.sha256}</td>
                    <td className="border-b border-border/70 px-3 py-2">{artifact.redacted ? "redacted" : "metadata only, raw not previewed"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </article>
  );
}

function LocalLink({ href, label, path }: { readonly href: string; readonly label: string; readonly path: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="rounded-xl border border-border bg-bg/55 p-3 font-mono text-xs text-primary transition hover:border-primary/50 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <span className="block font-sans text-sm font-semibold text-text">{label}</span>
      <span className="mt-1 block break-all">{path}</span>
    </a>
  );
}

function PreviewBlock({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <section className="rounded-xl border border-border bg-bg/55 p-4">
      <h4 className="text-sm font-semibold text-text">{title}</h4>
      <pre className="mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-text-muted">{body}</pre>
    </section>
  );
}

function redactedPreview(value: string): string {
  return value
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replaceAll(/[A-Za-z0-9_-]*api[_-]?key[A-Za-z0-9_=:-]*/gi, "[REDACTED_API_KEY]")
    .replaceAll(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_PEM]");
}
