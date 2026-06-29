import {
  summarizeCommandCenter,
  summarizeToolOps,
  type BundlePayload,
  type HealthPayload,
  type LatestRunPayload,
  type PolicyPayload,
  type ReportsPayload,
  type ResourceStatus,
  type TopologyPayload
} from "../lib/model.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";

interface OverviewProps {
  readonly run?: LatestRunPayload;
  readonly health?: HealthPayload;
  readonly topology?: TopologyPayload;
  readonly policies?: PolicyPayload;
  readonly reports?: ReportsPayload;
  readonly bundle?: BundlePayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

export function Overview({ run, health, topology, policies, reports, bundle, status, error }: OverviewProps) {
  const summary = summarizeToolOps(run, health);
  const commandCenter = summarizeCommandCenter({ run, health, topology, policies, reports, bundle, status });
  const commandCenterCards = [
    { label: "Current status", item: commandCenter.currentStatus },
    { label: "Topology health", item: commandCenter.topologyHealth },
    { label: "Side-effect risk", item: commandCenter.sideEffectRisk },
    { label: "Retries", item: commandCenter.retries },
    { label: "Policy decisions", item: commandCenter.policyDecisions },
    { label: "Evidence readiness", item: commandCenter.evidenceReadiness }
  ] as const;
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
      <section className="relative overflow-hidden rounded-[2rem] border border-primary/25 bg-[radial-gradient(circle_at_18%_0%,oklch(0.64_0.18_235_/_0.22),transparent_30rem),radial-gradient(circle_at_84%_6%,oklch(0.62_0.16_310_/_0.15),transparent_28rem),linear-gradient(135deg,oklch(0.19_0.038_260),oklch(0.10_0.02_260))] p-6 shadow-2xl shadow-black/30">
        <div className="absolute right-8 top-8 hidden h-36 w-36 rounded-full border border-primary/25 bg-primary/5 blur-sm lg:block" aria-hidden="true" />
        <div className="relative flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-4xl">
            <div className="flex flex-wrap gap-2">
              <StatusChip label="Run Health Command Center" tone="selected" />
              <StatusChip label={commandCenter.currentStatus.label} tone={commandCenter.currentStatus.tone} />
            </div>
            <h2 className="mt-4 text-4xl font-black tracking-[-0.045em] text-text sm:text-6xl">
              One landing screen for run status, risk, policy, and evidence readiness.
            </h2>
            <p className="mt-3 text-sm leading-6 text-text-muted sm:text-base">
              This command center combines Core health, topology, side-effect, retry, policy, and evidence signals. It
              stays useful when Core is loading, empty, partially degraded, or offline, and it avoids claims beyond
              routed ToolGuard boundaries.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-panel/85 p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-text-dim">Selected run</p>
            <p className="mt-2 max-w-72 break-all font-mono text-sm text-primary">{commandCenter.runId}</p>
            <p className="mt-3 text-xs leading-5 text-text-muted">{commandCenter.currentStatus.detail}</p>
          </div>
        </div>

        <div className="relative mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Run Health Command Center summary">
          {commandCenterCards.map(({ label, item }) => (
            <article key={label} className="rounded-2xl border border-border bg-bg/45 p-4 shadow-lg shadow-black/10">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm font-semibold text-text">{label}</h3>
                <StatusChip label={item.label} tone={item.tone} />
              </div>
              <p className="mt-3 text-sm leading-6 text-text-muted">{item.detail}</p>
            </article>
          ))}
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
          action="Recovery: from /home/zfahrny/Projects/toolplane run `TOOLGUARD_CORE_PORT=3660 pnpm dev:core`, then refresh. Keep using visible fixture and empty-state guidance while Core restarts."
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
          action="Recovery: verify Core health at http://127.0.0.1:3660/health, restart with the manifest command if needed, and continue using available correlation IDs."
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
