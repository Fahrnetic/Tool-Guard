import { useMemo, useState } from "react";
import { CorrelationGrid } from "../components/CorrelationGrid.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import { requestReplay } from "../lib/api.js";
import type { ReplayFixture, ReplayPayload, ReplayResponse, ResourceStatus } from "../lib/model.js";

interface ReplayLabProps {
  readonly payload?: ReplayPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

export function ReplayLab({ payload, status, error }: ReplayLabProps) {
  const [selectedFixture, setSelectedFixture] = useState("fixture.wrong-cwd");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ReplayResponse | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const sourceRunId = payload?.replayableRuns[0]?.sourceRunId ?? payload?.runId ?? "run:pending";
  const fixture = useMemo(() => payload?.fixtures.find((item) => item.id === selectedFixture), [payload?.fixtures, selectedFixture]);

  if (status === "loading") {
    return <StatePanel status="loading" title="Loading Replay Lab" message="Fetching replayable runs, safe fixtures, and blocked real-world actions from `/api/replay`." />;
  }
  if (status === "error") {
    return <StatePanel status="error" title="Replay Lab unavailable" message={error ?? "Core did not return replay metadata."} />;
  }
  if (!payload) {
    return <StatePanel status="empty" title="No replayable run" message="Replay metadata appears after Core has a run and registered fixtures." />;
  }

  async function runReplay(target: ReplayFixture) {
    setSubmitting(true);
    setActionError(undefined);
    setResult(undefined);
    try {
      const response = await requestReplay({
        toolName: target.id,
        sourceRunId,
        fixtureOnly: target.fixtureOnly,
        mode: target.fixtureOnly ? "fixture" : "real-world",
        destructive: target.destructiveRisk === "high"
      });
      setResult(response);
      if (response.status === "blocked" || response.status === "failed") {
        setActionError(response.reason ?? "Replay did not complete. Inspect the action result for details.");
      }
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <StatusChip label="Fixture-only deterministic replay" tone="selected" />
            <h2 className="mt-3 text-2xl font-semibold text-text">Replay Lab</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
              Reconstruct failed runs from evidence using safe fixtures only. Real-world destructive commands are visibly
              blocked before execution, while successful replays get fresh correlation IDs linked to the source run.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-panel p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-text-dim">sourceRunId</p>
            <p className="mt-1 break-all font-mono text-xs text-primary">{sourceRunId}</p>
          </div>
        </div>
      </div>

      {status === "degraded" ? (
        <StatePanel status="degraded" title="Partial replay metadata" message="Some Core endpoints failed, but fixture safety metadata remains inspectable." />
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
          <h3 className="text-lg font-semibold text-text">Replayable fixtures</h3>
          <p className="mt-1 text-sm text-text-muted">Choose a safe deterministic fixture or verify that unsafe replay is blocked.</p>
          <div className="mt-4 grid gap-3" role="radiogroup" aria-label="Replay fixture">
            {payload.fixtures.map((item) => {
              const selected = item.id === selectedFixture;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setSelectedFixture(item.id)}
                  className={`rounded-xl border p-4 text-left transition hover:border-primary/50 hover:bg-primary/10 active:scale-[0.99] ${
                    selected ? "border-primary/50 bg-primary/15" : "border-border bg-bg/55"
                  }`}
                >
                  <div className="flex flex-wrap gap-2">
                    <StatusChip label={item.status} tone={item.safe ? "healthy" : "failed"} />
                    <StatusChip label={item.fixtureOnly ? "fixture-only" : "real-world blocked"} tone={item.fixtureOnly ? "selected" : "failed"} />
                    <StatusChip label={`destructiveRisk ${item.destructiveRisk}`} tone={item.destructiveRisk === "high" ? "failed" : "neutral"} />
                  </div>
                  <p className="mt-3 font-semibold text-text">{item.label}</p>
                  <p className="mt-1 text-sm leading-6 text-text-muted">{item.description}</p>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={submitting || !fixture}
            aria-busy={submitting}
            onClick={() => {
              if (fixture) void runReplay(fixture);
            }}
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-primary/50 bg-primary/15 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" /> : null}
            {submitting ? "Replay pending..." : fixture?.fixtureOnly ? "Replay fixture safely" : "Verify blocked replay"}
          </button>
        </section>

        <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
          <h3 className="text-lg font-semibold text-text">Replay state</h3>
          {!result && !actionError && !submitting ? (
            <StatePanel status="empty" title="No replay submitted" message="Submit a fixture replay to create fresh IDs linked to the selected source run." />
          ) : null}
          {submitting ? <StatePanel status="loading" title="Replay request pending" message="Duplicate submissions are disabled while Core processes the fixture replay." /> : null}
          {actionError ? <StatePanel status={result?.status === "blocked" ? "degraded" : "error"} title={result?.status === "blocked" ? "Unsafe replay blocked" : "Replay failed"} message={actionError} /> : null}
          {result ? (
            <div className="mt-4 rounded-xl border border-border bg-bg/55 p-4">
              <div className="flex flex-wrap gap-2">
                <StatusChip label={result.status} tone={result.status === "success" ? "healthy" : result.status === "blocked" ? "failed" : "degraded"} />
                <StatusChip label={result.fixtureOnly ? "fixture-only" : "not fixture-only"} tone={result.fixtureOnly ? "selected" : "failed"} />
                <StatusChip label={result.safe ? "safe" : "unsafe blocked"} tone={result.safe ? "healthy" : "failed"} />
              </div>
              <p className="mt-3 break-all font-mono text-sm text-primary">replayId {result.replayId}</p>
              <p className="mt-1 break-all font-mono text-xs text-text-muted">sourceRunId {result.sourceRunId}</p>
              {result.freshCorrelation ? (
                <div className="mt-4">
                  <h4 className="mb-2 text-sm font-semibold text-text">Fresh correlation IDs</h4>
                  <CorrelationGrid correlation={result.freshCorrelation} compact />
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>

      <section className="rounded-2xl border border-border bg-bg-panel/90 p-5">
        <h3 className="text-lg font-semibold text-text">Latest replay-linked events</h3>
        {payload.latestReplayEvents.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">No replay events yet. Successful fixture replay events will appear here after the next refresh.</p>
        ) : (
          <ol className="mt-4 space-y-2">
            {payload.latestReplayEvents.map((event) => (
              <li key={event.eventId} className="rounded-xl border border-border bg-bg/55 p-3">
                <StatusChip label={event.type} tone="neutral" />
                <p className="mt-2 break-all font-mono text-xs text-primary">traceId {event.traceId}</p>
                <p className="text-sm text-text-muted">{event.summary}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
