import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell, type NavigationItem } from "./components/AppShell.js";
import { fetchFailures, fetchHealth, fetchIntegrations, fetchLatestRun, fetchNarrative, fetchPolicies, fetchReplay, fetchReports, fetchTopology, fetchTrace, streamCoreEvents } from "./lib/api.js";
import type { CoreEvent } from "@toolplane/core";
import type {
  FailureInboxPayload,
  HealthPayload,
  IntegrationsPayload,
  LatestRunPayload,
  NarrativePayload,
  PolicyPayload,
  ReplayPayload,
  ReportsPayload,
  ResourceStatus,
  ScreenId,
  TopologyPayload,
  TopologySelection,
  TracePayload
} from "./lib/model.js";
import { FailureInbox } from "./screens/FailureInbox.js";
import { FailureTopologyMap } from "./screens/FailureTopologyMap.js";
import { HealthMatrix } from "./screens/HealthMatrix.js";
import { HarnessIntegrations } from "./screens/HarnessIntegrations.js";
import { Overview } from "./screens/Overview.js";
import { PolicyStudio } from "./screens/PolicyStudio.js";
import { ReplayLab } from "./screens/ReplayLab.js";
import { EvidenceReportViewer } from "./screens/EvidenceReportViewer.js";
import { ScreenStateGallery } from "./screens/ScreenStateGallery.js";
import { Timeline } from "./screens/Timeline.js";
import { TraceExplorer } from "./screens/TraceExplorer.js";

const navigation: readonly NavigationItem[] = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Live Run Timeline" },
  { id: "topology", label: "Failure Topology Map" },
  { id: "health", label: "Tool Server Health Matrix" },
  { id: "failures", label: "Failure Inbox" },
  { id: "traces", label: "Trace Explorer" },
  { id: "replay", label: "Replay Lab" },
  { id: "policy", label: "Policy Studio" },
  { id: "integrations", label: "Harness Integrations" },
  { id: "reports", label: "Evidence Report Viewer" }
];

interface DataState {
  readonly run?: LatestRunPayload | undefined;
  readonly health?: HealthPayload | undefined;
  readonly topology?: TopologyPayload | undefined;
  readonly narrative?: NarrativePayload | undefined;
  readonly failures?: FailureInboxPayload | undefined;
  readonly trace?: TracePayload | undefined;
  readonly policies?: PolicyPayload | undefined;
  readonly integrations?: IntegrationsPayload | undefined;
  readonly replay?: ReplayPayload | undefined;
  readonly reports?: ReportsPayload | undefined;
  readonly status: ResourceStatus;
  readonly error?: string | undefined;
}

export function App() {
  const [active, setActive] = useState<ScreenId>("overview");
  const [data, setData] = useState<DataState>({ status: "loading" });
  const [streamEvents, setStreamEvents] = useState<CoreEvent[]>([]);
  const [streamState, setStreamState] = useState<"loading" | "connected" | "degraded" | "error">("loading");
  const [selectedCorrelationId, setSelectedCorrelationId] = useState<string | undefined>();
  const [topologySelection, setTopologySelection] = useState<TopologySelection | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setData({ status: "loading" });
      const [runResult, healthResult, topologyResult, narrativeResult, failureResult, traceResult, policyResult, integrationResult, replayResult, reportsResult] = await Promise.allSettled([
        fetchLatestRun(controller.signal),
        fetchHealth(controller.signal),
        fetchTopology("latest", controller.signal),
        fetchNarrative("latest", controller.signal),
        fetchFailures(controller.signal),
        fetchTrace("latest", controller.signal),
        fetchPolicies(controller.signal),
        fetchIntegrations(controller.signal),
        fetchReplay(controller.signal),
        fetchReports(controller.signal)
      ]);
      if (controller.signal.aborted) {
        return;
      }
      const run = runResult.status === "fulfilled" ? runResult.value : undefined;
      const health = healthResult.status === "fulfilled" ? healthResult.value : undefined;
      const topology = topologyResult.status === "fulfilled" ? topologyResult.value : undefined;
      const narrative = narrativeResult.status === "fulfilled" ? narrativeResult.value : undefined;
      const failures = failureResult.status === "fulfilled" ? failureResult.value : undefined;
      const trace = traceResult.status === "fulfilled" ? traceResult.value : undefined;
      const policies = policyResult.status === "fulfilled" ? policyResult.value : undefined;
      const integrations = integrationResult.status === "fulfilled" ? integrationResult.value : undefined;
      const replay = replayResult.status === "fulfilled" ? replayResult.value : undefined;
      const reports = reportsResult.status === "fulfilled" ? reportsResult.value : undefined;
      if (!run && !health) {
        const reason = runResult.status === "rejected" ? String(runResult.reason) : "Unknown Core API error";
        setData({ status: "error", error: reason });
        return;
      }
      if (run && run.eventCount === 0) {
        setData({ run, ...(health ? { health } : {}), ...(topology ? { topology } : {}), ...(narrative ? { narrative } : {}), ...(failures ? { failures } : {}), ...(trace ? { trace } : {}), ...(policies ? { policies } : {}), ...(integrations ? { integrations } : {}), ...(replay ? { replay } : {}), ...(reports ? { reports } : {}), status: "empty" });
        return;
      }
      const degradedError =
        [runResult, healthResult, topologyResult, narrativeResult, failureResult, traceResult, policyResult, integrationResult, replayResult, reportsResult].some((result) => result.status === "rejected")
          ? "One Core endpoint returned an error."
          : undefined;
      setData({
        ...(run ? { run } : {}),
        ...(health ? { health } : {}),
        ...(topology ? { topology } : {}),
        ...(narrative ? { narrative } : {}),
        ...(failures ? { failures } : {}),
        ...(trace ? { trace } : {}),
        ...(policies ? { policies } : {}),
        ...(integrations ? { integrations } : {}),
        ...(replay ? { replay } : {}),
        ...(reports ? { reports } : {}),
        status: [runResult, healthResult, topologyResult, narrativeResult, failureResult, traceResult, policyResult, integrationResult, replayResult, reportsResult].every((result) => result.status === "fulfilled") ? "ready" : "degraded",
        ...(degradedError ? { error: degradedError } : {})
      });
    }
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 5_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const refetchTraceForSelection = useCallback(async (selection: { readonly id: string; readonly kind: string; readonly traceId?: string }) => {
    setSelectedCorrelationId(selection.id);
    const traceId = selection.kind === "trace" ? selection.id : (selection.traceId ?? data.trace?.traceId ?? "latest");
    try {
      const trace = await fetchTrace(traceId);
      setData((current) => ({ ...current, trace, status: current.status === "error" ? "degraded" : current.status }));
    } catch (error) {
      setData((current) => ({
        ...current,
        status: "degraded",
        error: error instanceof Error ? error.message : "Trace refetch failed for selected correlation ID."
      }));
    }
  }, [data.trace?.traceId]);

  useEffect(() => {
    return streamCoreEvents({
      onState: setStreamState,
      onEvent: (event) => {
        setStreamEvents((current) => {
          if (current.some((existing) => existing.eventId === event.eventId)) {
            return current;
          }
          return [...current, event].sort((a, b) => a.sequence - b.sequence || a.occurredAt.localeCompare(b.occurredAt));
        });
      }
    });
  }, []);

  const coreState = useMemo(() => {
    if (data.status === "loading") {
      return "loading";
    }
    return data.status === "error" || data.status === "degraded" ? "degraded" : "connected";
  }, [data.status]);

  return (
    <AppShell
      active={active}
      items={navigation}
      coreState={coreState}
      runId={data.run?.runId ?? data.health?.runId ?? "pending"}
      onSelect={setActive}
    >
      {active === "overview" ? (
        <Overview {...(data.run ? { run: data.run } : {})} {...(data.health ? { health: data.health } : {})} status={data.status} {...(data.error ? { error: data.error } : {})} />
      ) : active === "timeline" ? (
        <Timeline events={streamEvents.length > 0 ? streamEvents : data.run?.events ?? []} status={data.status} streamState={streamState} {...(data.error ? { error: data.error } : {})} {...(topologySelection ? { topologySelection } : {})} />
      ) : active === "topology" ? (
        <FailureTopologyMap
          {...(data.topology ? { topology: data.topology } : {})}
          {...(data.narrative ? { narrative: data.narrative } : {})}
          {...(data.failures ? { failures: data.failures } : {})}
          events={streamEvents.length > 0 ? streamEvents : data.run?.events ?? []}
          {...(data.trace ? { trace: data.trace } : {})}
          {...(data.health ? { health: data.health } : {})}
          {...(data.reports ? { reports: data.reports } : {})}
          status={data.status}
          {...(data.error ? { error: data.error } : {})}
          onSelectCorrelation={refetchTraceForSelection}
          onSelectNode={setTopologySelection}
        />
      ) : active === "health" ? (
        <HealthMatrix {...(data.health ? { health: data.health } : {})} status={data.status} {...(data.error ? { error: data.error } : {})} {...(topologySelection ? { topologySelection } : {})} />
      ) : active === "failures" ? (
        <FailureInbox {...(data.failures ? { payload: data.failures } : {})} status={data.status} {...(data.error ? { error: data.error } : {})} {...(topologySelection ? { topologySelection } : {})} />
      ) : active === "traces" ? (
        <TraceExplorer
          {...(data.trace ? { payload: data.trace } : {})}
          status={data.status}
          {...(data.error ? { error: data.error } : {})}
          {...(selectedCorrelationId ? { selectedId: selectedCorrelationId } : {})}
          {...(topologySelection ? { topologySelection } : {})}
          onSelectCorrelation={refetchTraceForSelection}
        />
      ) : active === "replay" ? (
        <ReplayLab {...(data.replay ? { payload: data.replay } : {})} status={data.status} {...(data.error ? { error: data.error } : {})} />
      ) : active === "policy" ? (
        <PolicyStudio
          {...(data.policies ? { payload: data.policies } : {})}
          status={data.status}
          {...(data.error ? { error: data.error } : {})}
          onSaved={(policies) => setData((current) => ({ ...current, policies, status: current.status === "error" ? "degraded" : current.status }))}
        />
      ) : active === "integrations" ? (
        <HarnessIntegrations {...(data.integrations ? { payload: data.integrations } : {})} status={data.status} {...(data.error ? { error: data.error } : {})} />
      ) : active === "reports" ? (
        <EvidenceReportViewer {...(data.reports ? { payload: data.reports } : {})} status={data.status} {...(data.error ? { error: data.error } : {})} {...(topologySelection ? { topologySelection } : {})} />
      ) : (
        <ScreenStateGallery screen={active} />
      )}
    </AppShell>
  );
}
