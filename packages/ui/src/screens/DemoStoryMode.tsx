import { useEffect, useMemo, useState } from "react";
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
  const [activeStageId, setActiveStageId] = useState<StoryModePayload["stageOrder"][number]["id"] | undefined>(payload?.stageOrder[0]?.id);
  const [resetStatus, setResetStatus] = useState<string>("Ready");
  const selectedScenario = payload?.scenarios.find((scenario) => scenario.id === selectedScenarioId) ?? payload?.scenarios[0];
  const activeStage = payload?.stageOrder.find((stage) => stage.id === activeStageId) ?? payload?.stageOrder[0];
  const activeStageIndex = payload?.stageOrder.findIndex((stage) => stage.id === activeStage?.id) ?? 0;
  const progressPercent = payload && payload.stageOrder.length > 1 ? Math.round((activeStageIndex / (payload.stageOrder.length - 1)) * 100) : 0;
  const scenarioMetrics = useMemo(() => {
    const raw = selectedScenario?.comparison.raw;
    const mediated = selectedScenario?.comparison.mediated;
    if (!raw || !mediated) return [];
    return [
      {
        label: "Blast-radius reduction",
        value: `${Math.max(0, raw.blastRadiusScore - mediated.blastRadiusScore)} pts`,
        detail: `${raw.blastRadiusScore} raw to ${mediated.blastRadiusScore} guarded`
      },
      {
        label: "Evidence state",
        value: mediated.evidenceAvailability.includes("Failure Card") ? "ready" : "limited",
        detail: mediated.evidenceAvailability
      },
      {
        label: "Retry posture",
        value: mediated.retryBehavior.toLowerCase().includes("do not") || mediated.retryBehavior.toLowerCase().includes("suppressed") ? "contained" : "guided",
        detail: mediated.retryBehavior
      }
    ];
  }, [selectedScenario]);

  useEffect(() => {
    if (!payload) return;
    setSelectedScenarioId((current) => current ?? payload.scenarios[0]?.id);
    setActiveStageId((current) => current ?? payload.stageOrder[0]?.id);
  }, [payload]);

  if (status === "loading") {
    return <StorySkeleton />;
  }
  if (status === "error" || !payload) {
    return <StatePanel status="error" title="Story mode unavailable" message={error ?? "Start Core with pnpm demo:serve to load story mode."} />;
  }
  if (payload.scenarios.length === 0 || payload.stageOrder.length === 0) {
    return (
      <StatePanel
        status="empty"
        title="No story scenarios are available"
        message="Core responded, but the story scenario list is empty. Run pnpm demo:serve to seed deterministic story fixtures."
        action="Expected fixtures include raw failure, prompt injection, destructive block, retry loop, MCP, CLI, and Python sidecar scenarios."
      />
    );
  }

  return (
    <section className="space-y-6" aria-labelledby="story-mode-title">
      <div className="relative overflow-hidden rounded-[2rem] border border-primary/25 bg-[radial-gradient(circle_at_18%_0%,oklch(0.62_0.19_235_/_0.2),transparent_28rem),radial-gradient(circle_at_85%_12%,oklch(0.58_0.2_310_/_0.14),transparent_24rem),linear-gradient(135deg,oklch(0.18_0.035_260),oklch(0.085_0.018_260))] p-6 shadow-2xl shadow-primary/10">
        <div className="absolute right-6 top-6 hidden grid-cols-5 gap-1.5 md:grid" aria-hidden="true">
          {payload.stageOrder.map((stage, index) => (
            <span
              key={stage.id}
              className={`h-2 w-9 rounded-full transition-all duration-500 ${index <= activeStageIndex ? "bg-primary shadow-lg shadow-primary/30" : "bg-border"}`}
            />
          ))}
        </div>
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.36em] text-primary">Guided demo story mode</p>
              {status === "degraded" ? <StatusChip label="partial Core data" tone="degraded" /> : null}
            </div>
            <h2 id="story-mode-title" className="mt-3 max-w-4xl text-4xl font-black tracking-[-0.045em] text-text sm:text-6xl">
              The failure story, staged like a live incident review
            </h2>
            <p className="mt-4 text-sm leading-6 text-text-muted">
              Launch with <code className="rounded bg-bg-panel px-2 py-1 text-primary">{payload.serveCommand}</code>. The flow is fixture-only or loopback-only, uses stable labels, and keeps Core plus UI running for human viewing until you stop it.
            </p>
            {activeStage ? (
              <div className="mt-5 rounded-2xl border border-primary/25 bg-bg/45 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-text-dim">Now showing stage {activeStageIndex + 1} of {payload.stageOrder.length}</p>
                <p className="mt-2 text-xl font-bold text-text">{activeStage.label}</p>
                <p className="mt-1 text-sm leading-6 text-text-muted">{activeStage.narrative}</p>
              </div>
            ) : null}
          </div>
          <div className="grid gap-2 text-sm lg:min-w-56">
            <StatusChip label={`seed ${payload.deterministicSeed}`} tone="selected" />
            <StatusChip label="no credentials required" tone="healthy" />
            <StatusChip label="ports 3660-3664 only" tone="neutral" />
          </div>
        </div>
        <div className="relative mt-6 h-2 overflow-hidden rounded-full bg-bg-panel">
          <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${progressPercent}%` }} aria-hidden="true" />
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
                  className={`rounded-xl border p-4 text-left transition duration-200 hover:-translate-y-0.5 hover:border-primary/45 hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
                    selected ? "border-primary/65 bg-primary/15 shadow-lg shadow-primary/10" : "border-border bg-bg/50"
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
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-text">Step-by-step narrative navigation</h3>
                <p className="text-sm text-text-muted">Use the stages like a demo script, with visible selected, hover, and focus states.</p>
              </div>
              <StatusChip label={`${activeStageIndex + 1}/${payload.stageOrder.length}`} tone="selected" />
            </div>
            <ol className="mt-4 grid gap-3">
              {payload.stageOrder.map((stage, index) => (
                <li key={stage.id}>
                  <button
                    type="button"
                    aria-current={stage.id === activeStage?.id ? "step" : undefined}
                    onClick={() => setActiveStageId(stage.id)}
                    className={`w-full rounded-xl border p-4 text-left transition duration-200 hover:border-primary/45 hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
                      stage.id === activeStage?.id ? "border-primary/60 bg-primary/15" : "border-border bg-bg/45"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-primary/35 bg-primary/15 text-sm font-bold text-primary">
                        {index + 1}
                      </span>
                      <div>
                        <p className="font-semibold text-text">{stage.label}</p>
                        <p className="text-sm text-text-muted">{stage.narrative}</p>
                      </div>
                    </div>
                    <p className="mt-3 rounded-lg bg-bg-panel px-3 py-2 text-xs text-text-muted">{stage.expectedOutcome}</p>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      {selectedScenario ? (
        <div className="rounded-[1.75rem] border border-border bg-bg-panel/70 p-4 shadow-2xl shadow-black/15">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary">Before and after comparison</p>
              <h3 className="mt-2 text-2xl font-black tracking-tight text-text">Same deterministic fixture, two operating modes</h3>
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
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {scenarioMetrics.map((metric) => (
              <div key={metric.label} className="rounded-xl border border-border bg-bg/45 p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-dim">{metric.label}</p>
                <p className="mt-2 text-2xl font-black text-text">{metric.value}</p>
                <p className="mt-1 line-clamp-2 text-xs text-text-muted">{metric.detail}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <ComparisonCard title="Raw result" side={selectedScenario.comparison.raw} tone="raw" />
            <ComparisonCard title="ToolGuard result" side={selectedScenario.comparison.mediated} tone="guarded" />
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

function ComparisonCard({ title, side, tone }: { readonly title: string; readonly side: StoryModePayload["scenarios"][number]["comparison"]["raw"]; readonly tone: "raw" | "guarded" }) {
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
    <article className={`rounded-2xl border p-4 ${tone === "guarded" ? "border-success/35 bg-success/10" : "border-danger/30 bg-danger/10"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-lg font-black tracking-tight text-text">{title}</h4>
          <p className="mt-1 text-xs text-text-muted">{side.fixtureId}</p>
        </div>
        <StatusChip label={side.path === "toolguard" ? "mediated" : "baseline"} tone={side.path === "toolguard" ? "healthy" : "failed"} />
      </div>
      <div className="mt-4 rounded-xl border border-border/70 bg-bg/55 p-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-dim">Scenario input</p>
        <code className="mt-2 block break-all text-xs text-text-muted">{JSON.stringify(side.scenarioInput)}</code>
      </div>
      <dl className="mt-4 grid gap-3">
        {fields.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border/70 bg-bg/45 p-3">
            <dt className="text-xs font-semibold uppercase tracking-[0.18em] text-text-subtle">{label}</dt>
            <dd className="mt-1 text-sm leading-6 text-text-muted">{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function StorySkeleton() {
  return (
    <section className="space-y-6" aria-label="Loading Demo Story Mode">
      <div className="rounded-[2rem] border border-primary/25 bg-bg-panel/70 p-6">
        <div className="h-4 w-52 animate-pulse rounded-full bg-primary/25" />
        <div className="mt-5 h-12 max-w-3xl animate-pulse rounded-2xl bg-border/50" />
        <div className="mt-3 h-12 max-w-2xl animate-pulse rounded-2xl bg-border/40" />
        <div className="mt-6 grid gap-2 md:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="h-2 animate-pulse rounded-full bg-border" />
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-36 animate-pulse rounded-2xl border border-border bg-bg-panel/70" />
        ))}
      </div>
    </section>
  );
}
