import { useMemo, useState } from "react";
import { CorrelationGrid } from "../components/CorrelationGrid.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import { savePolicyPreview, simulatePolicy } from "../lib/api.js";
import type { PolicyPayload, PolicyScenarioId, PolicySimulation, ResourceStatus } from "../lib/model.js";

interface PolicyStudioProps {
  readonly payload?: PolicyPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
  readonly onSaved: (payload: PolicyPayload) => void;
}

export function PolicyStudio({ payload, status, error, onSaved }: PolicyStudioProps) {
  const [timeoutMs, setTimeoutMs] = useState(1000);
  const [retryLimit, setRetryLimit] = useState(1);
  const [circuitFailureThreshold, setCircuitFailureThreshold] = useState(2);
  const [outputLimitBytes, setOutputLimitBytes] = useState(4096);
  const [destructiveAction, setDestructiveAction] = useState<"block" | "allow-fixture-only">("block");
  const [scenarioId, setScenarioId] = useState<PolicyScenarioId>("blocked-destructive");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [simulating, setSimulating] = useState(false);
  const [simulation, setSimulation] = useState<PolicySimulation | undefined>();
  const [simulationError, setSimulationError] = useState<string | undefined>();
  const dirty =
    timeoutMs !== 1000 ||
    retryLimit !== 1 ||
    circuitFailureThreshold !== 2 ||
    outputLimitBytes !== 4096 ||
    destructiveAction !== "block";
  const validation = useMemo(() => {
    if (timeoutMs < 1) return "Timeout must be at least 1 ms.";
    if (retryLimit < 0) return "Retry limit cannot be negative.";
    if (retryLimit > 5) return "Retry limit must remain bounded at 5 or fewer.";
    if (circuitFailureThreshold < 1) return "Circuit failure threshold must be at least 1.";
    if (circuitFailureThreshold > 10) return "Circuit failure threshold must remain bounded at 10 or fewer.";
    if (outputLimitBytes < 1) return "Output limit must be at least 1 byte.";
    if (outputLimitBytes > 1024 * 1024) return "Output limit must remain bounded at 1 MiB or fewer.";
    return undefined;
  }, [circuitFailureThreshold, outputLimitBytes, retryLimit, timeoutMs]);

  if (status === "loading") {
    return <StatePanel status="loading" title="Loading Policy Studio" message="Fetching retry, circuit, timeout, output-limit, sanitizer, and preflight policy." />;
  }
  if (status === "error") {
    return <StatePanel status="error" title="Policy Studio unavailable" message={error ?? "Core did not return policy data."} />;
  }
  if (!payload) {
    return <StatePanel status="empty" title="No policy data" message="Policy defaults will appear after Core responds." />;
  }

  async function save() {
    if (validation) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const next = await savePolicyPreview({ timeoutMs, retryLimit });
      onSaved(next);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function simulate() {
    if (validation) return;
    setSimulating(true);
    setSimulation(undefined);
    setSimulationError(undefined);
    try {
      setSimulation(await simulatePolicy({
        scenarioId,
        proposedPolicy: {
          timeoutMs,
          retryLimit,
          circuitFailureThreshold,
          outputLimitBytes,
          outputBudgetBytes: outputLimitBytes,
          destructiveAction
        }
      }));
    } catch (caught) {
      setSimulation(undefined);
      setSimulationError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSimulating(false);
    }
  }

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <StatusChip label="Dry-run policy simulator" tone="selected" />
            <h2 className="mt-3 text-2xl font-semibold text-text">Policy Simulator</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
              Dry-run proposed policies against recorded local scenarios. The simulator calls Core at
              <span className="font-mono text-primary"> POST /api/policy/simulate</span> and never executes downstream
              side effects.
            </p>
          </div>
          {dirty ? <StatusChip label="Unsaved edits" tone="degraded" /> : <StatusChip label="No unsaved edits" tone="healthy" />}
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[0.78fr_1.22fr]">
        <form className="rounded-2xl border border-border bg-bg-panel/90 p-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <h3 className="text-lg font-semibold text-text">Scenario and policy controls</h3>
          <div className="mt-4 space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-text-muted">Recorded scenario</legend>
              {scenarioOptions.map((option) => (
                <label key={option.id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${scenarioId === option.id ? "border-primary/50 bg-primary/10" : "border-border bg-bg/45 hover:border-primary/35"}`}>
                  <input
                    type="radio"
                    name="scenario"
                    value={option.id}
                    checked={scenarioId === option.id}
                    onChange={() => setScenarioId(option.id)}
                    className="mt-1 accent-primary"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-text">{option.label}</span>
                    <span className="block text-sm leading-5 text-text-muted">{option.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="block text-sm font-medium text-text-muted">
              Timeout preview (ms)
              <input
                type="number"
                min={1}
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(Number(event.target.value))}
                className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2 text-text hover:border-primary/40 focus:border-primary"
              />
            </label>
            <label className="block text-sm font-medium text-text-muted">
              Retry limit
              <input
                type="number"
                min={0}
                max={5}
                value={retryLimit}
                onChange={(event) => setRetryLimit(Number(event.target.value))}
                className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2 text-text hover:border-primary/40 focus:border-primary"
              />
            </label>
            <label className="block text-sm font-medium text-text-muted">
              Circuit failure threshold
              <input
                type="number"
                min={1}
                max={10}
                value={circuitFailureThreshold}
                onChange={(event) => setCircuitFailureThreshold(Number(event.target.value))}
                className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2 text-text hover:border-primary/40 focus:border-primary"
              />
            </label>
            <label className="block text-sm font-medium text-text-muted">
              Output limit / budget (bytes)
              <input
                type="number"
                min={1}
                max={1024 * 1024}
                value={outputLimitBytes}
                onChange={(event) => setOutputLimitBytes(Number(event.target.value))}
                className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2 text-text hover:border-primary/40 focus:border-primary"
              />
            </label>
            <label className="block text-sm font-medium text-text-muted">
              Destructive action policy
              <select
                value={destructiveAction}
                onChange={(event) => setDestructiveAction(event.target.value as "block" | "allow-fixture-only")}
                className="mt-2 w-full rounded-xl border border-border bg-bg px-3 py-2 text-text hover:border-primary/40 focus:border-primary"
              >
                <option value="block">Block before execution</option>
                <option value="allow-fixture-only">Allow fixture-only simulation</option>
              </select>
            </label>
            {validation ? <p className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{validation}</p> : null}
            {saveError ? <p className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{saveError}</p> : null}
            {simulationError ? <p className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{simulationError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void simulate()} disabled={Boolean(validation) || simulating} className="rounded-xl border border-primary/50 bg-primary/15 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50">
                {simulating ? "Running dry-run..." : "Run simulation"}
              </button>
              <button type="submit" disabled={Boolean(validation) || saving} className="rounded-xl border border-primary/50 bg-primary/15 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50">
                {saving ? "Saving preview..." : "Save preview"}
              </button>
              <button type="button" onClick={() => { setTimeoutMs(1000); setRetryLimit(1); setCircuitFailureThreshold(2); setOutputLimitBytes(4096); setDestructiveAction("block"); }} className="rounded-xl border border-border bg-bg px-4 py-2 text-sm font-semibold text-text-muted transition hover:border-primary/40 hover:text-text active:scale-[0.98]">
                Reset
              </button>
              <button type="button" onClick={() => setSaveError(undefined)} className="rounded-xl border border-border bg-bg px-4 py-2 text-sm font-semibold text-text-muted transition hover:border-primary/40 hover:text-text active:scale-[0.98]">
                Cancel error
              </button>
            </div>
          </div>
        </form>

        <section className="space-y-5">
          <div className="rounded-2xl border border-border bg-bg-panel/90 p-5">
            <h3 className="text-lg font-semibold text-text">Decision preview</h3>
            <div className="mt-4 rounded-xl border border-border bg-bg/55 p-4">
              <StatusChip label={payload.preview.decision} tone={payload.preview.decision === "block" || payload.preview.decision === "fail-fast" ? "failed" : payload.preview.decision === "retry" ? "degraded" : "healthy"} />
              <p className="mt-3 break-all font-mono text-sm text-primary">policyDecisionId {payload.preview.policyDecisionId}</p>
              <p className="mt-2 text-sm leading-6 text-text-muted">{payload.preview.reason}</p>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {payload.rules.map((rule) => (
                <article key={rule.id} className="rounded-xl border border-border bg-bg/55 p-4">
                  <h4 className="text-sm font-semibold text-text">{rule.label}</h4>
                  <p className="mt-1 text-sm text-primary">{rule.value}</p>
                  <p className="mt-2 text-sm leading-6 text-text-muted">{rule.description}</p>
                </article>
              ))}
            </div>
          </div>

          <SimulationPanel simulation={simulation} loading={simulating} />
        </section>
      </div>

      <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
        <h3 className="text-lg font-semibold text-text">Recorded policy decisions</h3>
        <div className="mt-4 grid gap-3">
          {payload.decisions.length === 0 ? <p className="text-sm text-text-muted">No policy.decision events in this run yet.</p> : null}
          {payload.decisions.map((decision) => (
            <article key={decision.eventId} className="rounded-xl border border-border bg-bg/55 p-4">
              <div className="flex flex-wrap gap-2">
                <StatusChip label={decision.decision} tone={decision.decision === "block" || decision.decision === "fail-fast" ? "failed" : "healthy"} />
                <StatusChip label={decision.retryable ? "retryable" : "not retryable"} tone={decision.retryable ? "degraded" : "neutral"} />
              </div>
              <p className="mt-2 text-sm text-text-muted">{decision.reason}</p>
              <div className="mt-3"><CorrelationGrid correlation={decision.correlation} compact /></div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}

const scenarioOptions: readonly { id: PolicyScenarioId; label: string; description: string }[] = [
  { id: "safe-success", label: "Safe success", description: "A healthy recorded call that can close a circuit after a recovery signal." },
  { id: "blocked-destructive", label: "Blocked destructive fixture", description: "A high-risk filesystem scenario that should move from allowed risk to pre-execution block." },
  { id: "retry-loop-failure", label: "Retry-loop containment", description: "A repeated process failure where the proposed policy can fail fast and open a scoped circuit." },
  { id: "output-budget-flood", label: "Output-budget flood", description: "An oversized output scenario where output-limit policy can reduce model-facing context waste." }
];

function SimulationPanel({ simulation, loading }: { readonly simulation: PolicySimulation | undefined; readonly loading: boolean }) {
  if (loading) {
    return <StatePanel status="loading" title="Simulating policy" message="Core is dry-running the proposed policy against recorded local scenario data." />;
  }
  if (!simulation) {
    return (
      <StatePanel
        status="empty"
        title="No simulation run yet"
        message="Choose a scenario, adjust policy controls, then run a dry-run preview. Results will show decisions, blast-radius before/after deltas, and evidence links."
      />
    );
  }
  const deltaTone = simulation.blastRadius.delta < 0 ? "healthy" : simulation.blastRadius.delta > 0 ? "failed" : "neutral";
  return (
    <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <StatusChip label="evidence-only dry run" tone="selected" />
          <h3 className="mt-3 text-lg font-semibold text-text">{simulation.scenarioName}</h3>
          <p className="mt-2 text-sm leading-6 text-text-muted">{simulation.explanation}</p>
        </div>
        <StatusChip label={`delta ${simulation.blastRadius.delta > 0 ? "+" : ""}${simulation.blastRadius.delta}`} tone={deltaTone} />
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <BlastCard label="Before" score={simulation.blastRadius.before.score} detail={simulation.blastRadius.before.label} factors={simulation.blastRadius.before.factors} />
        <BlastCard label="After" score={simulation.blastRadius.after.score} detail={simulation.blastRadius.after.label} factors={simulation.blastRadius.after.factors} />
        <article className="rounded-xl border border-border bg-bg/55 p-4">
          <h4 className="text-sm font-semibold text-text">Preview decisions</h4>
          <div className="mt-3 flex flex-wrap gap-2">
            {simulation.previewDecisions.map((decision) => (
              <StatusChip key={decision} label={decision} tone={decision.includes("block") || decision === "fail-fast" ? "failed" : decision === "retry" ? "degraded" : "healthy"} />
            ))}
          </div>
          <p className="mt-3 text-sm leading-6 text-text-muted">
            Downstream executed: {simulation.dryRun.downstreamExecuted ? "yes" : "no"}. Side effects executed: {simulation.dryRun.sideEffectsExecuted ? "yes" : "no"}.
          </p>
        </article>
      </div>
      <div className="mt-4 rounded-xl border border-border bg-bg/55 p-4">
        <h4 className="text-sm font-semibold text-text">Policy change and evidence</h4>
        <p className="mt-2 text-sm text-text-muted">
          Proposed retry limit {simulation.proposedPolicy.retryLimit}, circuit threshold {simulation.proposedPolicy.circuitFailureThreshold},
          timeout {simulation.proposedPolicy.timeoutMs} ms, output limit {simulation.proposedPolicy.outputLimitBytes} bytes,
          destructive action {simulation.proposedPolicy.destructiveAction}.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {simulation.evidenceLinks.map((link) => (
            <StatusChip key={link.artifactId} label={link.label} tone="selected" />
          ))}
        </div>
      </div>
    </section>
  );
}

function BlastCard({ label, score, detail, factors }: { readonly label: string; readonly score: number; readonly detail: string; readonly factors: readonly { readonly name: string; readonly score: number; readonly explanation: string }[] }) {
  return (
    <article className="rounded-xl border border-border bg-bg/55 p-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-text">{label} blast radius</h4>
        <span className="font-mono text-2xl font-semibold text-primary">{score}</span>
      </div>
      <p className="mt-1 text-sm capitalize text-text-muted">{detail}</p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-text-muted">
        {factors.map((factor) => <li key={factor.name}>{factor.name}: {factor.explanation} ({factor.score})</li>)}
      </ul>
    </article>
  );
}
