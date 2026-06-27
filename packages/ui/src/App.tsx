import { useEffect, useMemo, useState } from "react";
import { AppShell, type NavigationItem } from "./components/AppShell.js";
import { fetchHealth, fetchLatestRun } from "./lib/api.js";
import type { HealthPayload, LatestRunPayload, ResourceStatus, ScreenId } from "./lib/model.js";
import { HealthMatrix } from "./screens/HealthMatrix.js";
import { Overview } from "./screens/Overview.js";
import { ScreenStateGallery } from "./screens/ScreenStateGallery.js";

const navigation: readonly NavigationItem[] = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Live Run Timeline" },
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
  readonly status: ResourceStatus;
  readonly error?: string | undefined;
}

export function App() {
  const [active, setActive] = useState<ScreenId>("overview");
  const [data, setData] = useState<DataState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setData({ status: "loading" });
      const [runResult, healthResult] = await Promise.allSettled([
        fetchLatestRun(controller.signal),
        fetchHealth(controller.signal)
      ]);
      if (controller.signal.aborted) {
        return;
      }
      const run = runResult.status === "fulfilled" ? runResult.value : undefined;
      const health = healthResult.status === "fulfilled" ? healthResult.value : undefined;
      if (!run && !health) {
        const reason = runResult.status === "rejected" ? String(runResult.reason) : "Unknown Core API error";
        setData({ status: "error", error: reason });
        return;
      }
      if (run && run.eventCount === 0) {
        setData({ run, ...(health ? { health } : {}), status: "empty" });
        return;
      }
      const degradedError =
        runResult.status === "rejected" || healthResult.status === "rejected" ? "One Core endpoint returned an error." : undefined;
      setData({
        ...(run ? { run } : {}),
        ...(health ? { health } : {}),
        status: runResult.status === "fulfilled" && healthResult.status === "fulfilled" ? "ready" : "degraded",
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
      ) : active === "health" ? (
        <HealthMatrix {...(data.health ? { health: data.health } : {})} status={data.status} {...(data.error ? { error: data.error } : {})} />
      ) : (
        <ScreenStateGallery screen={active} />
      )}
    </AppShell>
  );
}
