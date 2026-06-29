import { useState } from "react";
import { resetStoryScenario } from "../lib/api.js";
import type { ResourceStatus, StoryModePayload } from "../lib/model.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";

interface DemoStoryModeProps {
  readonly payload?: StoryModePayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

export function DemoStoryMode({ payload, status, error }: DemoStoryModeProps) {
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | undefined>(payload?.scenarios[0]?.id);
  const [resetStatus, setResetStatus] = useState<string>("Ready");
  const selectedScenario = payload?.scenarios.find((scenario) => scenario.id === selectedScenarioId) ?? payload?.scenarios[0];

  if (status === "loading") {
    return <StatePanel status="loading" title="Loading story mode" message="Core is preparing deterministic scenario data and stage guidance." />;
  }
  if (status === "error" || !payload) {
    return <StatePanel status="error" title="Story mode unavailable" message={error ?? "Start Core with pnpm demo:serve to load story mode."} />;
  }

  return (
    <section className="space-y-6" aria-labelledby="story-mode-title">
      <div className="overflow-hidden rounded-3xl border border-primary/25 bg-[radial-gradient(circle_at_top_left,oklch(0.46_0.18_265_/_0.28),transparent_34%),linear-gradient(135deg,oklch(0.17_0.03_260),oklch(0.09_0.02_260))] p-6 shadow-2xl shadow-primary/10">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.36em] text-primary">Guided demo story mode</p>
            <h2 id="story-mode-title" className="mt-3 text-3xl font-black tracking-tight text-text sm:text-5xl">
              Raw failure to ToolGuard evidence, in five deterministic stages
            </h2>
            <p className="mt-4 text-sm leading-6 text-text-muted">
              Launch with <code className="rounded bg-bg-panel px-2 py-1 text-primary">{payload.serveCommand}</code>. The flow is fixture-only or loopback-only, uses stable labels, and keeps Core plus UI running for human viewing until you stop it.
            </p>
          </div>
          <div className="grid gap-2 text-sm">
            <StatusChip label={`seed ${payload.deterministicSeed}`} tone="selected" />
            <StatusChip label="no credentials required" tone="healthy" />
            <StatusChip label="ports 3660-3664 only" tone="neutral" />
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-2xl border border-border bg-bg-panel/70 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-text">Scenario picker</h3>
              <p className="text-sm text-text-muted">Choose one of the stable deterministic fixtures.</p>
            </div>
            <StatusChip label={`${payload.scenarios.length} scenarios`} tone="healthy" />
          </div>
          <div className="mt-4 grid gap-3" role="listbox" aria-label="Story scenarios">
            {payload.scenarios.map((scenario) => {
              const selected = scenario.id === selectedScenario?.id;
              return (
                <button
                  key={scenario.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => setSelectedScenarioId(scenario.id)}
                  className={`rounded-xl border p-4 text-left transition hover:border-primary/45 hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
                    selected ? "border-primary/55 bg-primary/15" : "border-border bg-bg/50"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-text">{scenario.label}</span>
                    <StatusChip label={scenario.route} tone={scenario.route === "fixture-only" ? "healthy" : "neutral"} />
                  </div>
                  <p className="mt-2 text-xs text-text-muted">{scenario.stableLabel}</p>
                  <p className="mt-2 text-sm text-text-muted">{scenario.deterministicOutcome}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-bg-panel/70 p-4">
            <h3 className="text-lg font-semibold text-text">Step-by-step narrative</h3>
            <ol className="mt-4 grid gap-3">
              {payload.stageOrder.map((stage, index) => (
                <li key={stage.id} className="rounded-xl border border-border bg-bg/45 p-4">
                  <div className="flex items-center gap-3">
                    <span className="grid h-8 w-8 place-items-center rounded-full border border-primary/35 bg-primary/15 text-sm font-bold text-primary">
                      {index + 1}
                    </span>
                    <div>
                      <p className="font-semibold text-text">{stage.label}</p>
                      <p className="text-sm text-text-muted">{stage.narrative}</p>
                    </div>
                  </div>
                  <p className="mt-3 rounded-lg bg-bg-panel px-3 py-2 text-xs text-text-muted">{stage.expectedOutcome}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      {selectedScenario ? (
        <div className="rounded-2xl border border-border bg-bg-panel/70 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-text">Before and after, same fixture</h3>
              <p className="text-sm text-text-muted">{selectedScenario.comparison.sameFixtureProof}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setResetStatus("Resetting deterministic fixture state");
                void resetStoryScenario({ scenarioId: selectedScenario.id })
                  .then(() => setResetStatus(`Reset complete for ${selectedScenario.label}`))
                  .catch((resetError: unknown) => setResetStatus(resetError instanceof Error ? resetError.message : "Reset failed"));
              }}
              className="rounded-xl border border-primary/45 bg-primary/15 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            >
              {selectedScenario.resetControl.label}
            </button>
          </div>
          <p className="mt-3 text-xs text-text-muted">{resetStatus}</p>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <ComparisonCard title="Raw path" side={selectedScenario.comparison.raw} />
            <ComparisonCard title="ToolGuard path" side={selectedScenario.comparison.mediated} />
          </div>
          <div className="mt-4 rounded-xl border border-border bg-bg/45 p-4 text-sm text-text-muted">
            <p><span className="font-semibold text-text">Scenario cleanup:</span> {selectedScenario.cleanup.afterScenario}</p>
            <p className="mt-2"><span className="font-semibold text-text">Exit cleanup:</span> {selectedScenario.cleanup.onExit}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ComparisonCard({ title, side }: { readonly title: string; readonly side: StoryModePayload["scenarios"][number]["comparison"]["raw"] }) {
  const fields = [
    ["Failure type", side.failureType],
    ["Safe summary", side.safeSummary],
    ["Retry behavior", side.retryBehavior],
    ["Blast radius", `${side.blastRadiusScore}`],
    ["Side effects", side.sideEffects],
    ["Evidence", side.evidenceAvailability],
    ["Recovery", side.recoveryGuidance]
  ] as const;
  return (
    <article className="rounded-xl border border-border bg-bg/45 p-4">
      <h4 className="text-base font-semibold text-text">{title}</h4>
      <p className="mt-1 text-xs text-text-muted">{side.fixtureId}</p>
      <dl className="mt-4 space-y-3">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs font-semibold uppercase tracking-[0.18em] text-text-subtle">{label}</dt>
            <dd className="mt-1 text-sm text-text-muted">{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
