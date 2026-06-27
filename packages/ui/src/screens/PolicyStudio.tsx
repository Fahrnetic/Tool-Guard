import { useMemo, useState } from "react";
import { CorrelationGrid } from "../components/CorrelationGrid.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import { savePolicyPreview } from "../lib/api.js";
import type { PolicyPayload, ResourceStatus } from "../lib/model.js";

interface PolicyStudioProps {
  readonly payload?: PolicyPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
  readonly onSaved: (payload: PolicyPayload) => void;
}

export function PolicyStudio({ payload, status, error, onSaved }: PolicyStudioProps) {
  const [timeoutMs, setTimeoutMs] = useState(1000);
  const [retryLimit, setRetryLimit] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const dirty = timeoutMs !== 1000 || retryLimit !== 1;
  const validation = useMemo(() => {
    if (timeoutMs < 1) return "Timeout must be at least 1 ms.";
    if (retryLimit < 0) return "Retry limit cannot be negative.";
    if (retryLimit > 5) return "Retry limit must remain bounded at 5 or fewer.";
    return undefined;
  }, [retryLimit, timeoutMs]);

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

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <StatusChip label="Policy preview before execution" tone="selected" />
            <h2 className="mt-3 text-2xl font-semibold text-text">Policy Studio</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
              Tune accessible preview controls and see allow, retry, block, and circuit decisions with policyDecisionId
              before downstream execution.
            </p>
          </div>
          {dirty ? <StatusChip label="Unsaved edits" tone="degraded" /> : <StatusChip label="No unsaved edits" tone="healthy" />}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
        <form className="rounded-2xl border border-border bg-bg-panel/90 p-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <h3 className="text-lg font-semibold text-text">Preview controls</h3>
          <div className="mt-4 space-y-4">
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
            {validation ? <p className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{validation}</p> : null}
            {saveError ? <p className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{saveError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={Boolean(validation) || saving} className="rounded-xl border border-primary/50 bg-primary/15 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50">
                {saving ? "Saving preview..." : "Save preview"}
              </button>
              <button type="button" onClick={() => { setTimeoutMs(1000); setRetryLimit(1); }} className="rounded-xl border border-border bg-bg px-4 py-2 text-sm font-semibold text-text-muted transition hover:border-primary/40 hover:text-text active:scale-[0.98]">
                Reset
              </button>
              <button type="button" onClick={() => setSaveError(undefined)} className="rounded-xl border border-border bg-bg px-4 py-2 text-sm font-semibold text-text-muted transition hover:border-primary/40 hover:text-text active:scale-[0.98]">
                Cancel error
              </button>
            </div>
          </div>
        </form>

        <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
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
