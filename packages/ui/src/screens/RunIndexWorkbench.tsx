import { useMemo, useState } from "react";
import type { RunIndexRecord } from "@toolplane/core";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import type { ResourceStatus, RunComparisonGroup, RunIndexFilters, RunIndexFilterWindow, RunIndexPayload } from "../lib/model.js";

interface RunIndexWorkbenchProps {
  readonly payload?: RunIndexPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

const filterWindows: readonly { value: RunIndexFilterWindow; label: string }[] = [
  { value: "all", label: "All indexed time" },
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" }
];

const defaultFilters: RunIndexFilters = {
  failureType: "all",
  routeType: "all",
  toolOrStatus: "",
  timeWindow: "all"
};

export function RunIndexWorkbench({ payload, status, error }: RunIndexWorkbenchProps) {
  const [filters, setFilters] = useState<RunIndexFilters>(defaultFilters);
  const records = payload?.records ?? [];
  const latestFailures = useMemo(() => records.filter(isFailureRecord), [records]);
  const filteredFailures = useMemo(() => filterRunIndexRecords(latestFailures, filters), [filters, latestFailures]);
  const comparisons = useMemo(() => buildRunComparisons(filteredFailures), [filteredFailures]);
  const failureTypes = uniqueOptionValues(latestFailures.map((record) => record.firstFailure?.failureType).filter(Boolean));
  const routeTypes = uniqueOptionValues(latestFailures.map((record) => record.routeType));

  if (status === "loading") {
    return <StatePanel status="loading" title="Loading Run Index" message="Fetching latest real failures from Core `/api/run-index`." />;
  }
  if (status === "error") {
    return <StatePanel status="error" title="Run Index unavailable" message={error ?? "Core did not return the run index."} />;
  }
  if (!payload) {
    return <StatePanel status="degraded" title="Run Index degraded" message="Core responded, but the run index payload was missing." action="Confirm `/api/run-index` is available on 127.0.0.1:3660." />;
  }

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6 shadow-2xl shadow-black/20">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <StatusChip label="Core run index backed" tone="selected" />
            <h2 className="mt-3 text-2xl font-semibold text-text">Latest real failures and correlated attempts</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
              This view reads Core&apos;s durable run index, highlights latest failed runs, and compares raw, mediated,
              and repeated attempts when labels, commands, or tool targets provide a correlation key.
            </p>
          </div>
          <div className="grid gap-2 rounded-2xl border border-border bg-bg/60 p-4 text-sm text-text-muted sm:grid-cols-3">
            <Metric label="Indexed runs" value={payload.count.toString()} />
            <Metric label="Real failures" value={latestFailures.length.toString()} />
            <Metric label="Filtered" value={filteredFailures.length.toString()} />
          </div>
        </div>
        <p className="mt-4 break-all font-mono text-xs text-text-dim">Index: {payload.indexPath}</p>
      </div>

      <div className="rounded-2xl border border-border bg-bg-panel/90 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <FilterSelect
            id="failure-type-filter"
            label="Failure type"
            value={filters.failureType}
            options={failureTypes}
            allLabel="All failure types"
            onChange={(failureType) => setFilters((current) => ({ ...current, failureType }))}
          />
          <FilterSelect
            id="route-filter"
            label="Route"
            value={filters.routeType}
            options={routeTypes}
            allLabel="All routes"
            onChange={(routeType) => setFilters((current) => ({ ...current, routeType }))}
          />
          <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm font-semibold text-text">
            Tool or status
            <input
              value={filters.toolOrStatus}
              onChange={(event) => setFilters((current) => ({ ...current, toolOrStatus: event.target.value }))}
              placeholder="Search tool, command, run name, or status"
              className="min-h-11 rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text outline-none transition focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
            />
          </label>
          <label className="flex min-w-44 flex-col gap-2 text-sm font-semibold text-text">
            Time
            <select
              value={filters.timeWindow}
              onChange={(event) => setFilters((current) => ({ ...current, timeWindow: event.target.value as RunIndexFilterWindow }))}
              className="min-h-11 rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text outline-none transition focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              {filterWindows.map((window) => <option key={window.value} value={window.value}>{window.label}</option>)}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setFilters(defaultFilters)}
            className="min-h-11 rounded-xl border border-border bg-bg px-4 py-2 text-sm font-semibold text-text-muted transition hover:border-primary/60 hover:text-text focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            Reset filters
          </button>
        </div>
      </div>

      {filteredFailures.length === 0 ? (
        <StatePanel
          status="empty"
          title="No indexed failures match these filters"
          message="The run index is reachable, but the current failure type, route, tool/status, and time filters removed every failed run."
          action="Reset filters or run a failing routed fixture to add a fresh failure."
        />
      ) : (
        <div className="grid gap-4">
          {filteredFailures.map((record) => <RunFailureCard key={record.runId} record={record} />)}
        </div>
      )}

      <section className="space-y-3" aria-label="Run comparison">
        <div className="rounded-2xl border border-border bg-bg-elevated/80 p-5">
          <StatusChip label="Comparison: raw vs mediated vs repeated attempts" tone={comparisons.length > 0 ? "healthy" : "neutral"} />
          <h3 className="mt-3 text-xl font-semibold text-text">Correlated attempt comparison</h3>
          <p className="mt-2 text-sm leading-6 text-text-muted">
            Groups use safe run labels first, then command or tool fingerprints. Raw direct runs, ToolGuard-mediated
            routes, and repeated attempts are separated so retry loops and mediation changes are visible.
          </p>
        </div>
        {comparisons.length === 0 ? (
          <StatePanel status="empty" title="No correlated attempts yet" message="Comparison appears once the index has at least two failures sharing a session, task, command, or tool fingerprint." />
        ) : (
          comparisons.slice(0, 4).map((group) => <ComparisonGroupCard key={group.key} group={group} />)
        )}
      </section>
    </section>
  );
}

export function filterRunIndexRecords(records: readonly RunIndexRecord[], filters: RunIndexFilters, now = new Date()): readonly RunIndexRecord[] {
  const threshold = thresholdFor(filters.timeWindow, now);
  const query = filters.toolOrStatus.trim().toLowerCase();
  return records.filter((record) => {
    if (filters.failureType !== "all" && record.firstFailure?.failureType !== filters.failureType) return false;
    if (filters.routeType !== "all" && record.routeType !== filters.routeType) return false;
    if (threshold && new Date(record.startedAt).getTime() < threshold.getTime()) return false;
    if (!query) return true;
    return [
      record.status,
      record.tool,
      record.command ?? "",
      record.runName,
      record.downstreamTarget.toolName,
      record.downstreamTarget.originalToolName ?? "",
      record.firstFailure?.summary ?? "",
      record.firstFailure?.failureType ?? ""
    ].some((value) => value.toLowerCase().includes(query));
  });
}

export function buildRunComparisons(records: readonly RunIndexRecord[]): readonly RunComparisonGroup[] {
  const groups = new Map<string, RunIndexRecord[]>();
  for (const record of records) {
    const key = comparisonKey(record);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()]
    .flatMap(([key, groupRecords]) => {
      const sorted = groupRecords.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      const firstRecord = sorted[0];
      if (!firstRecord) return [];
      const raw = sorted.filter((record) => record.routeType === "direct");
      const mediated = sorted.filter((record) => record.routeType !== "direct");
      const repeated = sorted.filter((record, index, source) => source.some((other, otherIndex) => otherIndex !== index && sameAttemptFingerprint(record, other)));
      return [{
        key,
        label: comparisonLabel(firstRecord),
        raw,
        mediated,
        repeated,
        records: sorted
      }];
    })
    .filter((group) => group.records.length > 1 && (group.raw.length > 0 || group.mediated.length > 0 || group.repeated.length > 0))
    .sort((a, b) => {
      const aLatest = a.records[0]?.startedAt ?? "";
      const bLatest = b.records[0]?.startedAt ?? "";
      return bLatest.localeCompare(aLatest);
    });
}

function RunFailureCard({ record }: { readonly record: RunIndexRecord }) {
  return (
    <article className="rounded-2xl border border-border bg-bg-panel/90 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            <StatusChip label={record.firstFailure?.failureType ?? "failed"} tone="failed" />
            <StatusChip label={record.routeType} tone={record.routeType === "direct" ? "warning" : "selected"} />
            <StatusChip label={record.status} tone="failed" />
          </div>
          <h3 className="mt-3 text-xl font-semibold text-text">{record.runName}</h3>
          <p className="mt-2 text-sm leading-6 text-text-muted">{record.firstFailure?.summary ?? "Failure was recorded without a first-failure summary."}</p>
        </div>
        <time className="font-mono text-xs text-text-dim">{record.startedAt}</time>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Info label="Tool" value={record.tool} />
        <Info label="Target" value={record.downstreamTarget.id} />
        <Info label="Harness" value={record.hostHarness.name} />
        <Info label="Adapter" value={record.adapter.name} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {record.labels.session ? <StatusChip label={`session ${record.labels.session}`} /> : null}
        {record.labels.task ? <StatusChip label={`task ${record.labels.task}`} /> : null}
        {record.command ? <StatusChip label={record.command} tone="neutral" /> : null}
      </div>
    </article>
  );
}

function ComparisonGroupCard({ group }: { readonly group: RunComparisonGroup }) {
  return (
    <article className="rounded-2xl border border-border bg-bg-panel/90 p-5 shadow-2xl shadow-black/20">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <h4 className="text-lg font-semibold text-text">{group.label}</h4>
        <span className="font-mono text-xs text-text-dim">{group.key}</span>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <ComparisonLane title="Raw result" records={group.raw} empty="No direct raw failure in this correlation group." />
        <ComparisonLane title="ToolGuard mediated result" records={group.mediated} empty="No mediated failure in this correlation group." />
        <ComparisonLane title="Repeated attempts" records={group.repeated} empty="No repeated attempt fingerprint in this group." />
      </div>
    </article>
  );
}

function ComparisonLane({ title, records, empty }: { readonly title: string; readonly records: readonly RunIndexRecord[]; readonly empty: string }) {
  return (
    <section className="rounded-xl border border-border bg-bg/55 p-4">
      <h5 className="text-sm font-semibold text-text">{title}</h5>
      {records.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-text-dim">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {records.map((record) => (
            <li key={record.runId} className="rounded-lg border border-border bg-bg/70 p-3">
              <div className="flex flex-wrap gap-2">
                <StatusChip label={record.routeType} tone={record.routeType === "direct" ? "warning" : "selected"} />
                <StatusChip label={record.firstFailure?.failureType ?? record.status} tone="failed" />
              </div>
              <p className="mt-2 text-sm font-semibold text-text">{record.runName}</p>
              <p className="mt-1 text-xs leading-5 text-text-muted">{record.firstFailure?.summary ?? "No summary available."}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FilterSelect({ id, label, value, options, allLabel, onChange }: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly allLabel: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label htmlFor={id} className="flex min-w-44 flex-col gap-2 text-sm font-semibold text-text">
      {label}
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text outline-none transition focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        <option value="all">{allLabel}</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-[0.18em] text-text-dim">{label}</p>
      <p className="mt-1 text-xl font-semibold text-text">{value}</p>
    </div>
  );
}

function Info({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg/55 p-3">
      <p className="text-xs uppercase tracking-[0.18em] text-text-dim">{label}</p>
      <p className="mt-1 break-words font-mono text-xs text-text">{value}</p>
    </div>
  );
}

function isFailureRecord(record: RunIndexRecord): boolean {
  return record.status === "failed" || Boolean(record.firstFailure);
}

function uniqueOptionValues(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));
}

function thresholdFor(window: RunIndexFilterWindow, now: Date): Date | undefined {
  const hour = 60 * 60 * 1_000;
  switch (window) {
    case "1h":
      return new Date(now.getTime() - hour);
    case "24h":
      return new Date(now.getTime() - 24 * hour);
    case "7d":
      return new Date(now.getTime() - 7 * 24 * hour);
    case "all":
      return undefined;
  }
}

function comparisonKey(record: RunIndexRecord): string {
  if (record.labels.task) return `task:${record.labels.task}`;
  if (record.labels.session) return `session:${record.labels.session}`;
  if (record.command) return `command:${record.command}`;
  return `tool:${record.tool}:${record.downstreamTarget.id}`;
}

function comparisonLabel(record: RunIndexRecord): string {
  if (record.labels.task) return `Task ${record.labels.task}`;
  if (record.labels.session) return `Session ${record.labels.session}`;
  return record.command ?? `${record.tool} on ${record.downstreamTarget.id}`;
}

function sameAttemptFingerprint(a: RunIndexRecord, b: RunIndexRecord): boolean {
  return comparisonKey(a) === comparisonKey(b) && a.routeType === b.routeType && a.tool === b.tool;
}
