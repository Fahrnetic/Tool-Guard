import { summarizeToolOps, type HealthPayload, type LatestRunPayload, type ResourceStatus } from "../lib/model.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";

interface OverviewProps {
  readonly run?: LatestRunPayload;
  readonly health?: HealthPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

export function Overview({ run, health, status, error }: OverviewProps) {
  const summary = summarizeToolOps(run, health);
  const cards = [
    { label: "Harnesses", value: summary.harnessCount, note: "Direct, MCP, framework, CLI paths" },
    { label: "Adapters", value: summary.adapterCount, note: "Connected ToolGuard surfaces" },
    { label: "Downstream tools", value: summary.downstreamToolCount, note: summary.preflightLabel },
    { label: "Failures", value: summary.failureCount, note: "Normalized Failure Cards" },
    { label: "Policy decisions", value: summary.retryOrPolicyCount, note: "Allow, retry, block, circuit" },
    { label: "Artifacts", value: summary.artifactCount, note: "Raw output separated from safe summaries" }
  ];

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-3xl border border-border bg-bg-elevated/80 p-6 shadow-2xl shadow-black/30">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <StatusChip label="Overview, true ToolOps health from Core API data" tone="selected" />
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-text sm:text-4xl">
              Tool execution health without hiding the evidence trail.
            </h2>
            <p className="mt-3 text-sm leading-6 text-text-muted sm:text-base">
              The Overview combines Core run events and `/api/health` preflight data, including harnesses, adapters,
              downstream tools, failures, policy decisions, circuit state, report links, and correlation IDs.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-panel p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-text-dim">Selected run</p>
            <p className="mt-2 max-w-72 break-all font-mono text-sm text-primary">{summary.runId}</p>
          </div>
        </div>
      </section>

      {status === "loading" ? (
        <StatePanel status="loading" title="Loading ToolOps snapshot" message="Fetching latest run events and health matrix from Core." />
      ) : null}
      {status === "error" ? (
        <StatePanel
          status="error"
          title="Core API unavailable"
          message={error ?? "The UI could not reach ToolGuard Core on 127.0.0.1:3660."}
          action="Start the core service with the mission manifest command, then refresh."
        />
      ) : null}
      {status === "empty" ? (
        <StatePanel
          status="empty"
          title="No run events yet"
          message="ToolGuard is reachable, but no run events have been recorded for the selected session."
          action="Run a demo or trigger a mediated tool call to populate the observability model."
        />
      ) : null}
      {status === "degraded" ? (
        <StatePanel
          status="degraded"
          title="Partial observability data"
          message="Some Core API data is available, but at least one health or run endpoint could not be read."
          action="The visible panels keep correlation context so debugging can continue."
        />
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="ToolOps health summary cards">
        {cards.map((card) => (
          <article
            key={card.label}
            className="rounded-2xl border border-border bg-bg-panel/80 p-5 transition hover:-translate-y-0.5 hover:border-primary/45 hover:bg-bg-panel"
          >
            <p className="text-sm font-medium text-text-muted">{card.label}</p>
            <p className="mt-3 text-3xl font-semibold text-text">{card.value}</p>
            <p className="mt-2 text-sm leading-6 text-text-dim">{card.note}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
        <div className="rounded-2xl border border-border bg-bg-panel/80 p-5">
          <h3 className="text-lg font-semibold text-text">Correlation context</h3>
          <p className="mt-1 text-sm text-text-muted">Labels are shown with values, never by color alone.</p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            {summary.correlationIds.map((id, index) => (
              <div key={`${id}-${index}`} className="rounded-xl border border-border bg-bg/50 p-3">
                <dt className="text-xs uppercase tracking-[0.2em] text-text-dim">{index === 0 ? "runId" : `correlation ${index}`}</dt>
                <dd className="mt-1 break-all font-mono text-xs text-primary">{id}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="rounded-2xl border border-border bg-bg-panel/80 p-5">
          <h3 className="text-lg font-semibold text-text">Reports</h3>
          {summary.reportLinks.length > 0 ? (
            <ul className="mt-4 space-y-2">
              {summary.reportLinks.map((link) => (
                <li key={link} className="break-all rounded-xl border border-border bg-bg/50 p-3 font-mono text-xs text-primary">
                  {link}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm leading-6 text-text-muted">No report export event yet. Exported reports will appear here with local artifact links.</p>
          )}
        </div>
      </section>
    </div>
  );
}
