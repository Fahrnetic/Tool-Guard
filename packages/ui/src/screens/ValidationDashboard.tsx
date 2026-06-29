import type { ResourceStatus, ValidationDashboardPayload, ValidationCheckView } from "../lib/model.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";

interface ValidationDashboardProps {
  readonly payload?: ValidationDashboardPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

export function ValidationDashboard({ payload, status, error }: ValidationDashboardProps) {
  if (status === "loading") {
    return <StatePanel status="loading" title="Loading Validation Dashboard" message="Reading local check status from Core." />;
  }
  if (status === "error" || !payload) {
    return (
      <StatePanel
        status="error"
        title="Validation Dashboard unavailable"
        message={error ?? "Core is not serving validation checks on 127.0.0.1:3660."}
        action="Recovery: restart Core/API on port 3660, reset the fixture stack, then rerun pnpm demo."
      />
    );
  }

  return (
    <section className="space-y-6" aria-labelledby="validation-dashboard-title">
      <div className="rounded-[2rem] border border-primary/25 bg-bg-panel/80 p-6 shadow-2xl shadow-black/20">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-primary">Local acceptance gates</p>
            <h2 id="validation-dashboard-title" className="mt-3 text-4xl font-black tracking-[-0.045em] text-text sm:text-5xl">
              Validation Dashboard
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-text-muted">
              One local screen for tests, typecheck, lint, demo readiness, evidence export, no-secret scan, and process hygiene.
              Warnings mean the UI can see the check but still needs a fresh command transcript.
            </p>
          </div>
          <div className="grid gap-2">
            <StatusChip label={`seed ${payload.deterministicSeed}`} tone="selected" />
            <StatusChip label={`ports ${payload.approvedPorts[0]}-${payload.approvedPorts[payload.approvedPorts.length - 1]}`} tone="healthy" />
            <StatusChip label={`runId ${payload.runId}`} tone="neutral" />
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Validation check indicators">
        {payload.checks.map((check) => (
          <ValidationCheckCard key={check.id} check={check} />
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-bg-panel/80 p-5">
        <h3 className="text-lg font-semibold text-text">Output coverage for no-secret scan</h3>
        <p className="mt-1 text-sm text-text-muted">
          The scan covers generated ledgers, topology labels, narratives, bundle metadata, and story text.
        </p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(payload.artifactCoverage).map(([label, present]) => (
            <div key={label} className="rounded-xl border border-border bg-bg/45 p-3">
              <dt className="text-xs font-semibold uppercase tracking-[0.18em] text-text-dim">{label}</dt>
              <dd className="mt-2">
                <StatusChip label={present ? "present" : "missing"} tone={present ? "healthy" : "degraded"} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function ValidationCheckCard({ check }: { readonly check: ValidationCheckView }) {
  const tone = check.status === "pass" ? "healthy" : check.status === "fail" ? "failed" : "warning";
  return (
    <article className="rounded-2xl border border-border bg-bg-panel/80 p-5 transition hover:-translate-y-0.5 hover:border-primary/45">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-semibold text-text">{check.label}</h3>
        <StatusChip label={check.status} tone={tone} />
      </div>
      <p className="mt-4 text-sm leading-6 text-text-muted">{check.detail}</p>
    </article>
  );
}
