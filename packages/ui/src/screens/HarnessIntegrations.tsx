import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import type { IntegrationsPayload, ResourceStatus } from "../lib/model.js";

interface HarnessIntegrationsProps {
  readonly payload?: IntegrationsPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

export function HarnessIntegrations({ payload, status, error }: HarnessIntegrationsProps) {
  if (status === "loading") {
    return <StatePanel status="loading" title="Loading Harness Integrations" message="Fetching supported routes and claim levels from `/api/integrations`." />;
  }
  if (status === "error") {
    return <StatePanel status="error" title="Harness Integrations unavailable" message={error ?? "Core did not return integration metadata."} />;
  }
  if (!payload || payload.integrations.length === 0) {
    return <StatePanel status="empty" title="No integrations listed" message="Integration claim metadata is not available yet." />;
  }

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <StatusChip label="No native tool interception overclaims" tone="selected" />
        <h2 className="mt-3 text-2xl font-semibold text-text">Harness Integrations</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
          Each target states its supported route and claim level. ToolGuard only claims protection for calls routed through
          MCP, SDK wrappers, the CLI shim, or ToolGuard APIs.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {payload.integrations.map((integration) => (
          <article key={integration.id} className="rounded-2xl border border-border bg-bg-panel/90 p-5 transition hover:border-primary/45">
            <div className="flex flex-wrap gap-2">
              <StatusChip label={integration.route} tone={toneFor(integration.status)} />
              <StatusChip label={`claim: ${integration.claimLevel}`} tone={toneFor(integration.status)} />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-text">{integration.name}</h3>
            <p className="mt-2 text-sm leading-6 text-text-muted">{integration.limitation}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function toneFor(status: string): "healthy" | "degraded" | "failed" | "neutral" {
  if (status === "configured" || status === "available") return "healthy";
  if (status === "unsupported") return "failed";
  if (status === "not-yet-verified") return "degraded";
  return "neutral";
}
