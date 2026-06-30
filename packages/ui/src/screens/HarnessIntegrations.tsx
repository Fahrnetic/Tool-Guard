import { useMemo, useState } from "react";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import { exportReport, verifyIntegration } from "../lib/api.js";
import type {
  IntegrationEvidenceFreshness,
  IntegrationRouteCoverageView,
  IntegrationView,
  IntegrationsPayload,
  ResourceStatus,
  VerificationReceipt,
  VerificationRouteType
} from "../lib/model.js";

interface HarnessIntegrationsProps {
  readonly payload?: IntegrationsPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
}

export function HarnessIntegrations({ payload, status, error }: HarnessIntegrationsProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [verifying, setVerifying] = useState<VerificationRouteType | undefined>();
  const [receipts, setReceipts] = useState<VerificationReceipt[]>([]);
  const [verifyError, setVerifyError] = useState<string | undefined>();
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | undefined>();
  const selectedIntegration = useMemo(
    () => payload?.integrations.find((integration) => integration.id === selectedId) ?? payload?.integrations[0],
    [payload?.integrations, selectedId]
  );
  const coverageRows = useMemo(() => mergeCoverageRows(payload?.routeCoverage ?? [], receipts), [payload?.routeCoverage, receipts]);

  if (status === "loading") {
    return <StatePanel status="loading" title="Loading Harness Integrations" message="Fetching supported routes and claim levels from `/api/integrations`." />;
  }
  if (status === "error") {
    return <StatePanel status="error" title="Harness Integrations unavailable" message={error ?? "Core did not return integration metadata."} />;
  }
  if (!payload || payload.integrations.length === 0) {
    return <StatePanel status="empty" title="No integrations listed" message="Integration claim metadata is not available yet. The wizard will show configured, available, unsupported, and not-yet-verified routes after Core responds." />;
  }

  async function runProbe(routeType: VerificationRouteType) {
    setVerifying(routeType);
    setVerifyError(undefined);
    try {
      const receipt = await verifyIntegration({ routeType });
      setReceipts((current) => [receipt, ...current.filter((candidate) => candidate.receiptId !== receipt.receiptId)].slice(0, 6));
      setExportMessage("Receipt recorded as a redacted evidence artifact and ready for report export.");
    } catch (caught) {
      setVerifyError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setVerifying(undefined);
    }
  }

  async function exportEvidenceBundle() {
    setExporting(true);
    setExportMessage(undefined);
    try {
      const report = await exportReport();
      setExportMessage(`Report export ready: ${report.manifestValid ? "manifest valid" : "manifest has warnings"} at ${report.manifestUrl}. Verification receipts are recorded as redacted evidence artifacts.`);
    } catch (caught) {
      setVerifyError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <StatusChip label="Integration verification wizard" tone="selected" />
        <h2 className="mt-3 text-2xl font-semibold text-text">Harness Integration Verification</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
          Each target states its supported route and claim level. ToolGuard only claims protection for calls routed through
          MCP, SDK wrappers, the CLI shim, or ToolGuard APIs. Native host tools are not intercepted unless they use one of
          those routes.
        </p>
      </div>

      <CoverageMatrix rows={coverageRows} />

      <div className="grid gap-4 lg:grid-cols-[0.92fr_1.08fr]">
        <section className="grid gap-4 md:grid-cols-2">
        {payload.integrations.map((integration) => (
          <button
            key={integration.id}
            type="button"
            onClick={() => setSelectedId(integration.id)}
            className={`rounded-2xl border bg-bg-panel/90 p-5 text-left transition hover:border-primary/45 active:scale-[0.99] ${selectedIntegration?.id === integration.id ? "border-primary/60" : "border-border"}`}
          >
            <div className="flex flex-wrap gap-2">
              <StatusChip label={integration.route} tone={toneFor(integration.status)} />
              <StatusChip label={stateLabel(integration.status)} tone={toneFor(integration.status)} />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-text">{integration.name}</h3>
            <p className="mt-2 text-sm leading-6 text-text-muted">{integration.limitation}</p>
          </button>
        ))}
        </section>

        <section className="space-y-4">
          {selectedIntegration ? (
            <WizardPanel
              integration={selectedIntegration}
              receipts={receipts}
              verifying={verifying}
              onVerify={runProbe}
              exporting={exporting}
              onExport={exportEvidenceBundle}
            />
          ) : null}
          {verifyError ? <p className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">{verifyError}</p> : null}
          {exportMessage ? <p className="rounded-xl border border-success/35 bg-success/10 p-4 text-sm text-success">{exportMessage}</p> : null}
        </section>
      </div>
    </section>
  );
}

function CoverageMatrix({ rows }: { readonly rows: readonly IntegrationRouteCoverageView[] }) {
  const warnings = rows.filter((row) => row.warning);
  return (
    <section className="rounded-3xl border border-border bg-bg-panel/90 p-5" aria-label="Route coverage matrix">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <StatusChip label="Route coverage matrix" tone="selected" />
          <h3 className="mt-3 text-xl font-semibold text-text">Coverage honesty by integration route</h3>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-text-muted">
            The matrix separates mediated, supervised, observed, and not-covered paths. Availability is only claimed when
            local evidence exists, and stale or missing evidence is shown as a warning instead of false confidence.
          </p>
        </div>
        <StatusChip label={`${warnings.length} evidence warning${warnings.length === 1 ? "" : "s"}`} tone={warnings.length > 0 ? "warning" : "healthy"} />
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-[0.2em] text-text-subtle">
              <th className="border-b border-border px-3 py-3 font-semibold">Route</th>
              <th className="border-b border-border px-3 py-3 font-semibold">Coverage label</th>
              <th className="border-b border-border px-3 py-3 font-semibold">Configured</th>
              <th className="border-b border-border px-3 py-3 font-semibold">Available</th>
              <th className="border-b border-border px-3 py-3 font-semibold">Recent evidence</th>
              <th className="border-b border-border px-3 py-3 font-semibold">Warning / limitation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.routeType} className="group">
                <td className="border-b border-border/70 px-3 py-4 align-top">
                  <p className="font-semibold text-text">{row.label}</p>
                  <p className="mt-1 text-xs text-text-subtle">{row.routeType}</p>
                </td>
                <td className="border-b border-border/70 px-3 py-4 align-top">
                  <StatusChip label={row.claim} tone={toneForClaim(row.claim)} />
                </td>
                <td className="border-b border-border/70 px-3 py-4 align-top">
                  <StatusChip label={row.configured ? "configured" : "not configured"} tone={row.configured ? "healthy" : "degraded"} />
                </td>
                <td className="border-b border-border/70 px-3 py-4 align-top">
                  <StatusChip label={row.available ? "available" : "not verified"} tone={row.available ? "healthy" : "degraded"} />
                </td>
                <td className="border-b border-border/70 px-3 py-4 align-top">
                  <StatusChip label={freshnessLabel(row.evidenceFreshness)} tone={toneForFreshness(row.evidenceFreshness)} />
                  {row.lastEvidenceAt ? <p className="mt-2 text-xs text-text-subtle">{new Date(row.lastEvidenceAt).toLocaleString()}</p> : null}
                </td>
                <td className="border-b border-border/70 px-3 py-4 align-top">
                  {row.warning ? <p className="rounded-xl border border-warning/35 bg-warning/10 p-3 text-xs leading-5 text-warning">{row.warning}</p> : null}
                  <p className="mt-2 text-xs leading-5 text-text-muted">{row.limitation}</p>
                  <details className="mt-2 rounded-lg border border-border/70 bg-bg/45 p-2 text-xs text-text-muted">
                    <summary className="cursor-pointer font-semibold text-text">Evidence checks</summary>
                    <ul className="mt-2 space-y-2">
                      {row.checks.map((check) => (
                        <li key={`${check.label}-${check.state}`}>
                          <span className="font-semibold text-text">{check.label}</span>: {check.state}. {check.evidence}
                        </li>
                      ))}
                    </ul>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function mergeCoverageRows(
  baseRows: readonly IntegrationRouteCoverageView[],
  receipts: readonly VerificationReceipt[]
): readonly IntegrationRouteCoverageView[] {
  const fallbackRows = baseRows.length > 0 ? baseRows : defaultCoverageRows();
  return fallbackRows.map((row) => {
    if (row.routeType === "native-host-tools") return row;
    const latestReceipt = receipts.find((receipt) => receipt.routeType === row.routeType);
    if (!latestReceipt) return row;
    return {
      routeType: row.routeType,
      label: row.label,
      claim: row.claim,
      configured: latestReceipt.checkedCapabilities.some((check) => check.status === "configured"),
      available: latestReceipt.checkedCapabilities.some((check) => check.status === "available"),
      evidenceFreshness: "recent",
      lastEvidenceAt: latestReceipt.timestamp,
      limitation: row.limitation,
      checks: latestReceipt.routeCoverage.map((entry) => ({
        label: entry.label,
        state: entry.state,
        evidence: entry.evidence
      }))
    };
  });
}

function defaultCoverageRows(): readonly IntegrationRouteCoverageView[] {
  return [
    {
      routeType: "mcp-routed",
      label: "MCP routed adapter path",
      claim: "mediated",
      configured: false,
      available: false,
      evidenceFreshness: "missing",
      warning: "No recent evidence has been recorded for this configured route in the active Core session.",
      limitation: "Covered only when calls route through the ToolGuard MCP proxy.",
      checks: [{ label: "Evidence receipt", state: "not-verified", evidence: "No integration.verified receipt is present." }]
    },
    {
      routeType: "cli-supervised",
      label: "CLI supervised process path",
      claim: "supervised",
      configured: false,
      available: false,
      evidenceFreshness: "missing",
      warning: "No recent evidence has been recorded for this configured route in the active Core session.",
      limitation: "Covered at the process boundary through `toolguard run --`.",
      checks: [{ label: "Evidence receipt", state: "not-verified", evidence: "No integration.verified receipt is present." }]
    },
    {
      routeType: "sdk-wrapped-python",
      label: "Python SDK-wrapped sidecar path",
      claim: "observed",
      configured: false,
      available: false,
      evidenceFreshness: "missing",
      warning: "No recent evidence has been recorded for this configured route in the active Core session.",
      limitation: "Observed only for explicit wrapper and loopback sidecar usage.",
      checks: [{ label: "Evidence receipt", state: "not-verified", evidence: "No integration.verified receipt is present." }]
    },
    {
      routeType: "native-host-tools",
      label: "Native host tools without a ToolGuard route",
      claim: "not-covered",
      configured: false,
      available: false,
      evidenceFreshness: "missing",
      warning: "Not covered. Route calls through MCP, SDK wrappers, CLI shim, or ToolGuard API before claiming protection.",
      limitation: "ToolGuard does not claim native host interception for unrouted host tools.",
      checks: [{ label: "Coverage claim", state: "not-covered", evidence: "No routed ToolGuard boundary is configured for this row." }]
    }
  ];
}

function WizardPanel({ integration, receipts, verifying, onVerify, exporting, onExport }: {
  readonly integration: IntegrationView;
  readonly receipts: readonly VerificationReceipt[];
  readonly verifying: VerificationRouteType | undefined;
  readonly onVerify: (routeType: VerificationRouteType) => void;
  readonly exporting: boolean;
  readonly onExport: () => void;
}) {
  const routeType = routeTypeForIntegration(integration);
  const matchingReceipts = routeType ? receipts.filter((receipt) => receipt.routeType === routeType) : [];
  return (
    <div className="rounded-2xl border border-border bg-bg-panel/90 p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-text">{integration.name}</h3>
          <p className="mt-2 text-sm leading-6 text-text-muted">{integration.limitation}</p>
        </div>
        <StatusChip label={stateLabel(integration.status)} tone={toneFor(integration.status)} />
      </div>

      <div className="mt-5 rounded-xl border border-border bg-bg/55 p-4">
        <h4 className="text-sm font-semibold text-text">Route limitation</h4>
        <p className="mt-2 text-sm leading-6 text-text-muted">
          Verification is local-only and limited to the routed boundary shown here. It does not prove native host
          interception, global IDE interception, or direct framework tool interception outside ToolGuard.
        </p>
      </div>

      <div className="mt-5">
        <h4 className="text-sm font-semibold text-text">Copy-ready setup snippet</h4>
        <pre className="mt-2 overflow-x-auto rounded-xl border border-border bg-bg p-4 text-xs leading-5 text-text-muted"><code>{setupSnippetFor(integration)}</code></pre>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!routeType || integration.status === "unsupported" || verifying === routeType}
          onClick={() => routeType ? onVerify(routeType) : undefined}
          className="rounded-xl border border-primary/50 bg-primary/15 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {verifying === routeType ? "Running local probe..." : "Run verification probe"}
        </button>
        <button
          type="button"
          disabled={receipts.length === 0 || exporting}
          onClick={onExport}
          className="rounded-xl border border-border bg-bg px-4 py-2 text-sm font-semibold text-text-muted transition hover:border-primary/40 hover:text-text active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting ? "Exporting report..." : "Export receipts to report"}
        </button>
      </div>

      <div className="mt-5 space-y-3">
        <h4 className="text-sm font-semibold text-text">Verification receipts</h4>
        {matchingReceipts.length === 0 ? (
          <StatePanel status="empty" title="No receipt for this route" message="Run a local probe to record timestamped capability checks, limitations, and evidence artifact links." />
        ) : (
          matchingReceipts.map((receipt) => <ReceiptCard key={receipt.receiptId} receipt={receipt} />)
        )}
      </div>
    </div>
  );
}

function ReceiptCard({ receipt }: { readonly receipt: VerificationReceipt }) {
  return (
    <article className="rounded-xl border border-border bg-bg/55 p-4">
      <div className="flex flex-wrap gap-2">
        <StatusChip label={receipt.routeType} tone="selected" />
        <StatusChip label={new Date(receipt.timestamp).toLocaleString()} tone="neutral" />
      </div>
      <p className="mt-3 text-sm leading-6 text-text-muted">{receipt.limitation}</p>
      <div className="mt-4 grid gap-2">
        {receipt.checkedCapabilities.map((check) => (
          <div key={check.capability} className="rounded-lg border border-border bg-bg/65 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip label={check.status} tone={toneFor(check.status)} />
              <span className="text-sm font-semibold text-text">{check.capability}</span>
            </div>
            <p className="mt-2 text-sm text-text-muted">{check.evidence}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {receipt.evidenceLinks.map((link) => <StatusChip key={link.artifactId} label={link.label} tone="selected" />)}
      </div>
    </article>
  );
}

function routeTypeForIntegration(integration: IntegrationView): VerificationRouteType | undefined {
  if (integration.route === "MCP-routed") return "mcp-routed";
  if (integration.route === "SDK-wrapped") return "sdk-wrapped-python";
  if (integration.route === "CLI-supervised") return "cli-supervised";
  return undefined;
}

function stateLabel(status: string): string {
  if (status === "not-yet-verified") return "not yet verified";
  return status;
}

function setupSnippetFor(integration: IntegrationView): string {
  if (integration.route === "MCP-routed") {
    return `{
  "mcpServers": {
    "toolguard": {
      "command": "pnpm",
      "args": ["--filter", "@toolplane/mcp-adapter", "start"],
      "env": { "TOOLGUARD_CORE_URL": "http://127.0.0.1:3660" }
    }
  }
}`;
  }
  if (integration.route === "SDK-wrapped") {
    return `from toolplane import ToolGuardSidecarClient

client = ToolGuardSidecarClient("http://127.0.0.1:3660")
# Wrap framework tools explicitly. Direct framework tools are not intercepted.`;
  }
  if (integration.route === "CLI-supervised") {
    return `toolguard run -- <safe command>
# Process-level supervision only. Native agent tool calls need MCP, SDK wrapper, or API routing.`;
  }
  return `# Unsupported route in v0
# Route calls through MCP, an SDK wrapper, the CLI shim, or the ToolGuard API before claiming protection.`;
}

function toneFor(status: string): "healthy" | "degraded" | "failed" | "neutral" {
  if (status === "configured" || status === "available") return "healthy";
  if (status === "unsupported") return "failed";
  if (status === "not-yet-verified") return "degraded";
  return "neutral";
}

function toneForClaim(claim: string): "healthy" | "degraded" | "failed" | "neutral" | "selected" {
  if (claim === "mediated") return "healthy";
  if (claim === "supervised") return "selected";
  if (claim === "observed") return "degraded";
  if (claim === "not-covered") return "failed";
  return "neutral";
}

function freshnessLabel(freshness: IntegrationEvidenceFreshness): string {
  if (freshness === "recent") return "recent evidence";
  if (freshness === "stale") return "stale evidence";
  return "no recent evidence";
}

function toneForFreshness(freshness: IntegrationEvidenceFreshness): "healthy" | "warning" | "degraded" {
  if (freshness === "recent") return "healthy";
  if (freshness === "stale") return "warning";
  return "degraded";
}
