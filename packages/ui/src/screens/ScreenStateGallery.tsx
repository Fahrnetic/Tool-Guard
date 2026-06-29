import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import type { ScreenId } from "../lib/model.js";

const copy: Record<ScreenId, { readonly title: string; readonly description: string }> = {
  overview: {
    title: "Overview",
    description: "Run-level ToolOps health, correlation context, reports, and artifacts."
  },
  timeline: {
    title: "Live Run Timeline",
    description: "Append-only Core SSE events ordered by sequence and event time."
  },
  topology: {
    title: "Failure Topology Map",
    description: "Event-derived topology with node states, relationship labels, narrative, and linked evidence highlights."
  },
  health: {
    title: "Tool Server Health Matrix",
    description: "Harness, adapter, downstream server, and downstream tool preflight health."
  },
  failures: {
    title: "Failure Inbox",
    description: "Model-safe Failure Cards with retry guidance and evidence links."
  },
  traces: {
    title: "Trace Explorer",
    description: "Parent-child correlation from harness to adapter to downstream attempt."
  },
  replay: {
    title: "Replay Lab",
    description: "Fixture-only deterministic replay with unsafe action blocking."
  },
  story: {
    title: "Demo Story Mode",
    description: "Guided raw-to-ToolGuard story flow with deterministic scenarios and cleanup controls."
  },
  validation: {
    title: "Validation Dashboard",
    description: "Local gate checks for tests, typecheck, lint, demo readiness, evidence export, no-secret scan, and process hygiene."
  },
  policy: {
    title: "Policy Studio",
    description: "Timeouts, retry bounds, circuit thresholds, output limits, and sanitizer gates."
  },
  integrations: {
    title: "Harness Integrations",
    description: "Supported routes and claim levels without native interception overclaims."
  },
  reports: {
    title: "Evidence Report Viewer",
    description: "Static reports, manifests, artifact hashes, redaction summaries, and remediation."
  }
};

interface ScreenStateGalleryProps {
  readonly screen: ScreenId;
}

export function ScreenStateGallery({ screen }: ScreenStateGalleryProps) {
  const item = copy[screen];
  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <StatusChip label="Global screen state contract" tone="selected" />
        <h2 className="mt-3 text-2xl font-semibold text-text">{item.title}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">{item.description}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <StatePanel status="loading" title={`${item.title} loading`} message="Skeleton and progress affordances preserve layout while Core data is loading." />
        <StatePanel status="empty" title={`${item.title} empty`} message="Empty states explain what normally appears here and how to generate data." />
        <StatePanel status="degraded" title={`${item.title} degraded`} message="Partial data remains inspectable, with labels and correlation IDs still visible." />
        <StatePanel status="error" title={`${item.title} error`} message="Actionable errors identify the unavailable Core endpoint and the next recovery step." />
      </div>
      <div className="rounded-2xl border border-border bg-bg-panel/80 p-5">
        <h3 className="text-lg font-semibold text-text">Accessible primitive states</h3>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" className="rounded-xl border border-primary/50 bg-primary/15 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/20 active:scale-[0.98]">
            Enabled action
          </button>
          <button type="button" aria-pressed="true" className="rounded-xl border border-success/50 bg-success/15 px-4 py-2 text-sm font-medium text-success hover:bg-success/20 active:scale-[0.98]">
            Selected action
          </button>
          <button type="button" disabled className="rounded-xl border border-border bg-bg px-4 py-2 text-sm font-medium text-text-dim opacity-50">
            Disabled action
          </button>
          <button type="button" aria-busy="true" className="inline-flex items-center gap-2 rounded-xl border border-border-strong bg-bg px-4 py-2 text-sm font-medium text-text-muted">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Loading action
          </button>
        </div>
      </div>
    </section>
  );
}
