import { useMemo, useState } from "react";
import { generateVisibilitySetupSnippets } from "@toolplane/core/setup-snippets";
import type { HostConfigSnippet, PlatformCommandSnippet, SupportedMcpHostId } from "@toolplane/core/setup-snippets";
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
  const snippets = useMemo(() => generateVisibilitySetupSnippets(), []);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformCommandSnippet["platform"]>("posix");
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

      <OnboardingWorkbench
        integrations={payload.integrations}
        coverageRows={coverageRows}
        receipts={receipts}
        selectedIntegration={selectedIntegration}
        selectedPlatform={selectedPlatform}
        snippets={snippets.platforms}
        onSelectIntegration={setSelectedId}
        onSelectPlatform={setSelectedPlatform}
      />

      <RouteComparisonPanel rows={coverageRows} history={payload.coverageHistory ?? []} />

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
              platform={selectedPlatform}
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

const visibilityLevels: readonly {
  readonly level: string;
  readonly tone: "healthy" | "selected" | "degraded" | "neutral" | "failed";
  readonly copy: string;
}[] = [
  {
    level: "mediated",
    tone: "healthy",
    copy: "Tool calls pass through ToolGuard before execution, so policy, redaction, evidence, and failure cards are available."
  },
  {
    level: "supervised",
    tone: "selected",
    copy: "ToolGuard supervises a process boundary such as `toolguard run --`, but it cannot see host-native tool calls inside the process."
  },
  {
    level: "observed",
    tone: "degraded",
    copy: "A wrapper or importer reports useful facts to ToolGuard after explicit setup, with less control than mediated execution."
  },
  {
    level: "imported",
    tone: "neutral",
    copy: "Visibility comes from imported logs or receipts. ToolGuard can organize evidence but did not control the original call."
  },
  {
    level: "not-covered",
    tone: "failed",
    copy: "No routed, wrapped, supervised, or imported boundary is present. ToolGuard does not claim protection for this path."
  },
  {
    level: "unknown",
    tone: "neutral",
    copy: "ToolGuard has not received enough route evidence yet. Run a local setup or smoke test before relying on the route."
  }
];

function OnboardingWorkbench(input: {
  readonly integrations: readonly IntegrationView[];
  readonly coverageRows: readonly IntegrationRouteCoverageView[];
  readonly receipts: readonly VerificationReceipt[];
  readonly selectedIntegration: IntegrationView | undefined;
  readonly selectedPlatform: PlatformCommandSnippet["platform"];
  readonly snippets: readonly PlatformCommandSnippet[];
  readonly onSelectIntegration: (id: string) => void;
  readonly onSelectPlatform: (platform: PlatformCommandSnippet["platform"]) => void;
}) {
  const selected = input.selectedIntegration ?? input.integrations[0];
  const routeType = selected ? routeTypeForIntegration(selected) : undefined;
  const routeSnippets = routeType ? input.snippets.filter((snippet) => snippet.route === routeType) : [];
  const availablePlatforms: PlatformCommandSnippet["platform"][] =
    routeSnippets.length > 0 ? [...new Set(routeSnippets.map((snippet) => snippet.platform))] : ["posix"];
  const selectedSnippet =
    routeSnippets.find((snippet) => snippet.platform === input.selectedPlatform) ??
    routeSnippets[0];
  const setupSnippet = setupSnippetFor(selected, input.selectedPlatform);
  const latestReceipt = selected ? input.receipts.find((receipt) => receiptMatchesIntegration(receipt, selected)) : undefined;
  const coverage = input.coverageRows.find((row) => row.routeType === (routeType ?? "native-host-tools"));
  const routeLevelCoverageAppliesToPassport = routeType !== "mcp-routed";
  const smokeStatus = latestReceipt
    ? `Success. Smoke-test receipt ${latestReceipt.receiptId} was recorded at ${new Date(latestReceipt.timestamp).toLocaleString()}.`
    : routeLevelCoverageAppliesToPassport && coverage?.evidenceFreshness === "recent" && coverage.lastEvidenceAt
      ? `Success. Local proof exists from ${new Date(coverage.lastEvidenceAt).toLocaleString()}.`
      : selected?.status === "unsupported"
        ? "Unsupported. Route this harness through MCP, SDK wrappers, CLI supervision, or the ToolGuard API before expecting evidence."
        : routeType === "mcp-routed" && coverage?.evidenceFreshness === "recent"
          ? "Warning. Route-level MCP evidence exists, but no exact harness passport receipt matched this host identity, host family, or config hash."
        : "Warning. No local smoke-test receipt is visible yet. Run the next setup command below.";

  return (
    <section className="rounded-3xl border border-primary/20 bg-bg-panel/90 p-5 shadow-2xl shadow-black/25" aria-labelledby="visibility-workbench-heading">
      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div>
          <StatusChip label="Route-first onboarding" tone="selected" />
          <h3 id="visibility-workbench-heading" className="mt-3 text-2xl font-semibold text-text">
            Start with what ToolGuard can actually see
          </h3>
          <p className="mt-2 text-sm leading-6 text-text-muted">
            Pick a harness and platform, then copy a shared setup snippet. The workbench keeps unsupported paths visible,
            shows the next local command, and labels visibility by route instead of promising universal interception.
          </p>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.22em] text-text-dim">Harness</span>
              <select
                value={selected?.id ?? ""}
                onChange={(event) => input.onSelectIntegration(event.target.value)}
                className="mt-2 min-h-11 w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text"
                aria-label="Choose harness"
              >
                {input.integrations.map((integration) => (
                  <option key={integration.id} value={integration.id}>
                    {integration.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.22em] text-text-dim">Platform</span>
              <select
                value={availablePlatforms.includes(input.selectedPlatform) ? input.selectedPlatform : availablePlatforms[0]}
                onChange={(event) => input.onSelectPlatform(event.target.value as PlatformCommandSnippet["platform"])}
                className="mt-2 min-h-11 w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text"
                aria-label="Choose platform"
              >
                {availablePlatforms.map((platform) => (
                  <option key={platform} value={platform}>
                    {platformPlatformLabel(platform)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {visibilityLevels.map((level) => (
              <article key={level.level} className="rounded-2xl border border-border bg-bg/45 p-4">
                <StatusChip label={level.level} tone={level.tone} />
                <p className="mt-3 text-sm leading-6 text-text-muted">{level.copy}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <section className="rounded-2xl border border-border bg-bg/55 p-4" aria-label="Guided setup checklist">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-base font-semibold text-text">Guided setup checklist</h4>
              <StatusChip label={coverage?.claim ?? "unknown"} tone={toneForClaim(coverage?.claim ?? "unknown")} />
            </div>
            <ol className="mt-4 space-y-3 text-sm leading-6 text-text-muted">
              {setupSteps(selected, selectedSnippet).map((step, index) => (
                <li key={step} className="flex gap-3 rounded-xl border border-border/70 bg-bg-panel/55 p-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-primary/45 text-xs font-semibold text-primary">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="rounded-2xl border border-border bg-bg/55 p-4" aria-label="Copyable setup snippet">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-base font-semibold text-text">{setupSnippet.title}</h4>
              <button
                type="button"
                className="rounded-xl border border-primary/50 bg-primary/15 px-3 py-2 text-xs font-semibold text-primary transition hover:bg-primary/25 active:scale-[0.98]"
                aria-label="Copy setup snippet"
                onClick={() => void navigator.clipboard?.writeText(setupSnippet.command)}
              >
                Copy snippet
              </button>
            </div>
            <pre className="mt-3 max-h-64 overflow-auto rounded-xl border border-border bg-bg p-4 text-xs leading-5 text-text-muted">
              <code>{setupSnippet.command}</code>
            </pre>
            <p className="mt-3 text-xs leading-5 text-text-subtle">
              Snippet source: shared ToolGuard setup generator. Placeholders such as &lt;TOOLPLANE_REPO&gt; avoid developer-machine absolute paths.
            </p>
          </section>

          <section className="rounded-2xl border border-border bg-bg/55 p-4" aria-live="polite" aria-label="Smoke-test receipt status">
            <div className="flex flex-wrap gap-2">
              <StatusChip label={latestReceipt || (routeLevelCoverageAppliesToPassport && coverage?.evidenceFreshness === "recent") ? "success" : selected?.status === "unsupported" ? "unsupported" : "warning"} tone={latestReceipt || (routeLevelCoverageAppliesToPassport && coverage?.evidenceFreshness === "recent") ? "healthy" : selected?.status === "unsupported" ? "failed" : "warning"} />
              {coverage?.claim === "not-covered" ? <StatusChip label="not-covered" tone="failed" /> : null}
            </div>
            <p className="mt-3 text-sm leading-6 text-text-muted">{smokeStatus}</p>
          </section>
        </div>
      </div>

      <PassportDeck integrations={input.integrations} coverageRows={input.coverageRows} receipts={input.receipts} />
    </section>
  );
}

function PassportDeck(input: {
  readonly integrations: readonly IntegrationView[];
  readonly coverageRows: readonly IntegrationRouteCoverageView[];
  readonly receipts: readonly VerificationReceipt[];
}) {
  return (
    <section className="mt-6" aria-label="Harness passports">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-lg font-semibold text-text">Harness passports</h4>
          <p className="mt-1 text-sm text-text-muted">Each passport lists evidence fields, limitations, freshness, and current visibility level.</p>
        </div>
        <StatusChip label={`${input.integrations.length} harnesses`} tone="neutral" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {input.integrations.map((integration) => {
          const routeType = routeTypeForIntegration(integration);
          const coverage = input.coverageRows.find((row) => row.routeType === (routeType ?? "native-host-tools"));
          const receipt = input.receipts.find((candidate) => receiptMatchesIntegration(candidate, integration));
          return <PassportCard key={integration.id} integration={integration} coverage={coverage} receipt={receipt} />;
        })}
      </div>
    </section>
  );
}

function PassportCard({ integration, coverage, receipt }: {
  readonly integration: IntegrationView;
  readonly coverage: IntegrationRouteCoverageView | undefined;
  readonly receipt: VerificationReceipt | undefined;
}) {
  const requiresExactPassportEvidence = integration.route === "MCP-routed";
  const freshness = receipt ? "recent" : requiresExactPassportEvidence ? "missing" : (coverage?.evidenceFreshness ?? "missing");
  const evidenceFields = receipt
    ? receipt.checkedCapabilities.map((check) => `${check.capability}: ${check.status}`)
    : requiresExactPassportEvidence && coverage?.evidenceFreshness === "recent"
      ? ["Exact harness receipt: not verified", "Route-level MCP evidence was not projected onto this host passport"]
    : coverage?.checks.map((check) => `${check.label}: ${check.state}`) ?? ["Smoke-test receipt: not verified"];
  return (
    <article className="rounded-2xl border border-border bg-bg/55 p-4" tabIndex={0}>
      <div className="flex flex-wrap gap-2">
        <StatusChip label={coverage?.claim ?? "unknown"} tone={toneForClaim(coverage?.claim ?? "unknown")} />
        <StatusChip label={freshnessLabel(freshness)} tone={toneForFreshness(freshness)} />
      </div>
      <h5 className="mt-3 text-base font-semibold text-text">{integration.name}</h5>
      <p className="mt-2 text-sm leading-6 text-text-muted">{integration.limitation}</p>
      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-text-dim">Evidence fields</dt>
          <dd className="mt-2 text-text-muted">{evidenceFields.join("; ")}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-text-dim">Last verified</dt>
          <dd className="mt-2 text-text-muted">
            {receipt ? new Date(receipt.timestamp).toLocaleString() : requiresExactPassportEvidence ? "No exact harness proof yet" : coverage?.lastEvidenceAt ? new Date(coverage.lastEvidenceAt).toLocaleString() : "No local proof yet"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-text-dim">Limitations</dt>
          <dd className="mt-2 text-text-muted">{coverage?.limitation ?? "Route coverage is unknown until a local setup or smoke test runs."}</dd>
        </div>
      </dl>
    </article>
  );
}

function setupSteps(integration: IntegrationView | undefined, snippet: PlatformCommandSnippet | undefined): readonly string[] {
  if (!integration || integration.status === "unsupported") {
    return [
      "Choose a routed boundary such as MCP, SDK wrapper, CLI supervision, or ToolGuard API.",
      "Copy a supported setup snippet instead of relying on native host interception.",
      "Run a local smoke test to create a route-specific evidence receipt."
    ];
  }
  return [
    `Confirm ${integration.name} will use the ${integration.route} boundary, not an unrouted native tool path.`,
    `Copy the ${snippet?.title ?? "shared setup"} snippet for ${snippet ? platformPlatformLabel(snippet.platform) : "your platform"}.`,
    "Run the verification probe or smoke command, then check the passport for a fresh receipt and limitations."
  ];
}

function platformPlatformLabel(platform: PlatformCommandSnippet["platform"]): string {
  if (platform === "posix") return "POSIX shell";
  if (platform === "powershell") return "PowerShell";
  if (platform === "cmd") return "CMD";
  if (platform === "wsl") return "WSL";
  if (platform === "container") return "Container";
  return "CI";
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

function RouteComparisonPanel(input: {
  readonly rows: readonly IntegrationRouteCoverageView[];
  readonly history: NonNullable<IntegrationsPayload["coverageHistory"]>;
}) {
  const comparisons = input.rows.map((row) => routeComparisonFor(row, input.history));
  const visibleRows = comparisons.length > 0 ? comparisons : defaultCoverageRows().map((row) => routeComparisonFor(row, []));
  return (
    <section className="rounded-3xl border border-primary/20 bg-bg-panel/90 p-5 shadow-xl shadow-black/20" aria-label="Route comparison by visibility depth">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <StatusChip label="Route comparison" tone="selected" />
          <h3 className="mt-3 text-xl font-semibold text-text">Compare visibility depth, evidence, freshness, and blind spots</h3>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-text-muted">
            Persisted passport history, route receipts, and adapter visibility imports are compared side by side. Unsupported,
            stale, and unverified routes stay visible with the next safe action instead of success styling.
          </p>
        </div>
        <StatusChip label={`${visibleRows.length} route types`} tone={visibleRows.length >= 3 ? "healthy" : "warning"} />
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        {visibleRows.map((comparison) => (
          <article
            key={comparison.routeType}
            className="rounded-2xl border border-border bg-bg/60 p-4 focus-within:border-primary/60"
            tabIndex={0}
            data-route-comparison={comparison.routeType}
          >
            <div className="flex flex-wrap gap-2">
              <StatusChip label={comparison.visibilityLevel} tone={toneForClaim(comparison.visibilityLevel)} />
              <StatusChip label={comparison.freshnessLabel} tone={comparison.freshnessTone} />
              <StatusChip label={comparison.availableLabel} tone={comparison.availableTone} />
            </div>
            <h4 className="mt-3 text-base font-semibold text-text">{comparison.label}</h4>
            <dl className="mt-4 grid gap-3 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-text-dim">Visibility depth</dt>
                <dd className="mt-1 text-text-muted">{comparison.visibilityDepth}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-text-dim">Evidence depth</dt>
                <dd className="mt-1 text-text-muted">{comparison.evidenceDepth}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-text-dim">Freshness</dt>
                <dd className="mt-1 text-text-muted">{comparison.freshnessDetail}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-text-dim">Blind spots</dt>
                <dd className="mt-1 text-text-muted">{comparison.blindSpots}</dd>
              </div>
              <div className="rounded-xl border border-border/70 bg-bg-panel/60 p-3">
                <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-text-dim">Next action</dt>
                <dd className="mt-1 text-text">{comparison.nextAction}</dd>
              </div>
            </dl>
          </article>
        ))}
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

interface RouteComparisonView {
  readonly routeType: string;
  readonly label: string;
  readonly visibilityLevel: string;
  readonly visibilityDepth: string;
  readonly evidenceDepth: string;
  readonly freshnessLabel: string;
  readonly freshnessTone: "healthy" | "warning" | "degraded";
  readonly freshnessDetail: string;
  readonly availableLabel: string;
  readonly availableTone: "healthy" | "degraded" | "failed";
  readonly blindSpots: string;
  readonly nextAction: string;
}

function routeComparisonFor(
  row: IntegrationRouteCoverageView,
  history: NonNullable<IntegrationsPayload["coverageHistory"]>
): RouteComparisonView {
  const routeHistory = history.filter((entry) => entry.routeType === row.routeType);
  const latestHistory = routeHistory.at(-1);
  const evidenceCount = row.checks.filter((check) => check.state === "producing-evidence" || check.state === "available").length;
  return {
    routeType: row.routeType,
    label: row.label,
    visibilityLevel: row.claim,
    visibilityDepth: visibilityDepthFor(row),
    evidenceDepth: evidenceDepthFor(row, routeHistory.length, evidenceCount),
    freshnessLabel: freshnessLabel(row.evidenceFreshness),
    freshnessTone: toneForFreshness(row.evidenceFreshness),
    freshnessDetail: latestHistory
      ? `${freshnessLabel(latestHistory.evidenceFreshness)} from persisted passport history at ${new Date(latestHistory.lastVerifiedAt).toLocaleString()}.`
      : row.lastEvidenceAt
        ? `${freshnessLabel(row.evidenceFreshness)} recorded at ${new Date(row.lastEvidenceAt).toLocaleString()}.`
        : "No persisted passport or route evidence is available yet.",
    availableLabel: row.available && row.evidenceFreshness === "recent" ? "verified" : row.configured ? "unverified" : row.claim === "not-covered" ? "unsupported" : "not available",
    availableTone: row.available && row.evidenceFreshness === "recent" ? "healthy" : row.claim === "not-covered" ? "failed" : "degraded",
    blindSpots: blindSpotsFor(row),
    nextAction: nextActionFor(row)
  };
}

function visibilityDepthFor(row: IntegrationRouteCoverageView): string {
  if (row.claim === "mediated") return "Pre-execution control with policy, redaction, failure cards, and correlated evidence.";
  if (row.claim === "supervised") return "Process-boundary supervision with stdout/stderr evidence, but not host-native tool internals.";
  if (row.claim === "observed") return "Post-call or sidecar observation from explicit wrappers and imports.";
  if (row.claim === "imported") return "Imported external evidence organized by ToolGuard after the original call.";
  if (row.claim === "not-covered") return "No ToolGuard execution or observation boundary is present.";
  return "Unknown until a route receipt, passport, or visibility import is recorded.";
}

function evidenceDepthFor(row: IntegrationRouteCoverageView, historyCount: number, evidenceCount: number): string {
  const parts = [
    `${row.checks.length} capability check${row.checks.length === 1 ? "" : "s"}`,
    `${evidenceCount} evidence-producing signal${evidenceCount === 1 ? "" : "s"}`
  ];
  if (historyCount > 0) parts.push(`${historyCount} persisted passport/history entr${historyCount === 1 ? "y" : "ies"}`);
  return parts.join(", ");
}

function blindSpotsFor(row: IntegrationRouteCoverageView): string {
  if (row.claim === "not-covered") return row.limitation;
  if (row.evidenceFreshness === "missing") return `Unverified route. ${row.limitation}`;
  if (row.evidenceFreshness === "stale") return `Stale evidence. ${row.limitation}`;
  if (!row.available) return `Configured evidence is incomplete. ${row.limitation}`;
  return row.limitation;
}

function nextActionFor(row: IntegrationRouteCoverageView): string {
  if (row.claim === "not-covered") return "Choose MCP, SDK wrapper, CLI supervision, API routing, or an import path before claiming coverage.";
  if (row.evidenceFreshness === "stale") return "Re-run a local route probe to refresh the passport and evidence receipt.";
  if (row.evidenceFreshness === "missing") return "Run the route-specific smoke test or import visibility evidence for this route.";
  if (!row.available) return "Resolve failed capability checks, then re-run the local verification probe.";
  return "Keep this route in the mediated or supervised setup path and export the receipt with the evidence bundle.";
}

function WizardPanel({ integration, platform, receipts, verifying, onVerify, exporting, onExport }: {
  readonly integration: IntegrationView;
  readonly platform: PlatformCommandSnippet["platform"];
  readonly receipts: readonly VerificationReceipt[];
  readonly verifying: VerificationRouteType | undefined;
  readonly onVerify: (routeType: VerificationRouteType) => void;
  readonly exporting: boolean;
  readonly onExport: () => void;
}) {
  const routeType = routeTypeForIntegration(integration);
  const matchingReceipts = routeType ? receipts.filter((receipt) => receiptMatchesIntegration(receipt, integration)) : [];
  const probeButtonLabel = integration.status === "unsupported"
    ? "Unsupported route"
    : !routeType
      ? "Probe not available"
      : verifying === routeType
        ? "Running local probe..."
        : "Run verification probe";
  return (
    <div className="rounded-2xl border border-border bg-bg-panel/90 p-5" data-testid="selected-harness-wizard">
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
        <pre className="mt-2 overflow-x-auto rounded-xl border border-border bg-bg p-4 text-xs leading-5 text-text-muted" data-testid="selected-setup-snippet"><code>{setupSnippetFor(integration, platform).command}</code></pre>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!routeType || integration.status === "unsupported" || verifying === routeType}
          onClick={() => routeType ? onVerify(routeType) : undefined}
          className="rounded-xl border border-primary/50 bg-primary/15 px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {probeButtonLabel}
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

interface RenderedSetupSnippet {
  readonly title: string;
  readonly command: string;
}

export function setupSnippetFor(integration: IntegrationView | undefined, platform: PlatformCommandSnippet["platform"] = "posix"): RenderedSetupSnippet {
  const snippets = generateVisibilitySetupSnippets();
  if (!integration) return { title: "Unsupported route", command: "" };
  if (integration.route === "MCP-routed") {
    const hosts = mcpHostSnippetsForIntegration(integration, snippets.mcpHosts);
    const command = snippetForRouteAndPlatform(snippets.platforms, "mcp-routed", platform)?.command ??
      snippetCommand(snippets.platforms, "mcp-posix");
    if (hosts.length === 0) {
      return {
        title: `${integration.name} MCP setup`,
        command: [
          "# No exact MCP host card is available for this selection.",
          "# Choose a listed MCP host or route through CLI/SDK supervision.",
          command
        ].join("\n")
      };
    }
    const firstHost = hosts[0];
    return {
      title: hosts.length === 1 && firstHost ? `${firstHost.hostName} MCP host config` : `${integration.name} MCP host-family configs`,
      command: hosts.map((host) => renderMcpHostSetup(host, command)).join("\n\n")
    };
  }
  if (integration.route === "SDK-wrapped") {
    const snippet = snippetForRouteAndPlatform(snippets.platforms, "sdk-wrapped-python", platform);
    return { title: snippet?.title ?? "Python SDK wrapper", command: snippet?.command ?? snippetCommand(snippets.platforms, "python-wrapper") };
  }
  if (integration.route === "CLI-supervised") {
    const snippet = snippetForRouteAndPlatform(snippets.platforms, "cli-supervised", platform);
    return { title: snippet?.title ?? "CLI supervised command", command: snippet?.command ?? snippetCommand(snippets.platforms, "cli-posix") };
  }
  return {
    title: "Unsupported route",
    command: `# Unsupported route in v0
# Route calls through MCP, an SDK wrapper, the CLI shim, or the ToolGuard API before claiming protection.`
  };
}

function renderMcpHostSetup(host: HostConfigSnippet, platformCommand: string): string {
  return [
    `# ${host.hostName} (${host.hostFamily})`,
    `# Host ID: ${host.hostId}`,
    `# Config hash: ${configHash(host.configJson)}`,
    `# ${host.boundary}`,
    host.configJson,
    "",
    "# Platform launcher for the ToolGuard MCP stdio server:",
    platformCommand
  ].join("\n");
}

function mcpHostSnippetsForIntegration(
  integration: IntegrationView,
  hosts: readonly HostConfigSnippet[]
): readonly HostConfigSnippet[] {
  const hostIds = mcpHostIdsForIntegration(integration);
  if (hostIds.length > 0) {
    return hosts.filter((host) => hostIds.includes(host.hostId));
  }
  if (integration.hostFamily) {
    return hosts.filter((host) => host.hostFamily === integration.hostFamily);
  }
  return [];
}

export function mcpHostIdsForIntegration(integration: IntegrationView): readonly SupportedMcpHostId[] {
  const supported = integration.supportedHostIds?.filter(isSupportedMcpHostId) ?? [];
  if (supported.length > 0) return supported;
  if (isSupportedMcpHostId(integration.id)) return [integration.id];
  if (integration.id === "claude-desktop-code") return ["claude-desktop", "claude-code"];
  if (integration.id === "cursor-windsurf") return ["cursor", "windsurf"];
  return [];
}

function isSupportedMcpHostId(value: string): value is SupportedMcpHostId {
  return [
    "cline",
    "roo-code",
    "claude-desktop",
    "claude-code",
    "cursor",
    "windsurf",
    "codex-cli",
    "opencode",
    "hermes"
  ].includes(value);
}

export function receiptMatchesIntegration(receipt: VerificationReceipt, integration: IntegrationView): boolean {
  const routeType = routeTypeForIntegration(integration);
  if (!routeType || receipt.routeType !== routeType) return false;
  if (routeType !== "mcp-routed") return true;
  const hostIds = mcpHostIdsForIntegration(integration);
  const snippets = generateVisibilitySetupSnippets();
  const hostConfigs = mcpHostSnippetsForIntegration(integration, snippets.mcpHosts);
  const configHashes = new Set(hostConfigs.map((host) => configHash(host.configJson)));
  if (receipt.integrationId === integration.id) return true;
  if (receipt.hostId && hostIds.includes(receipt.hostId as SupportedMcpHostId)) return true;
  if (receipt.supportedHostIds?.some((hostId) => hostIds.includes(hostId as SupportedMcpHostId))) return true;
  if (receipt.configHash && configHashes.has(receipt.configHash)) return true;
  if (receipt.hostFamily && receipt.hostFamily === (integration.hostFamily ?? hostConfigs[0]?.hostFamily) && !hasExactReceiptHostMetadata(receipt)) return true;
  return receipt.evidenceLinks.some((link) =>
    link.integrationId === integration.id ||
    (link.hostId ? hostIds.includes(link.hostId as SupportedMcpHostId) : false) ||
    (link.supportedHostIds?.some((hostId) => hostIds.includes(hostId as SupportedMcpHostId)) ?? false) ||
    (link.configHash ? configHashes.has(link.configHash) : false) ||
    (link.hostFamily ? link.hostFamily === (integration.hostFamily ?? hostConfigs[0]?.hostFamily) && !hasExactReceiptHostMetadata(link) : false)
  );
}

function hasExactReceiptHostMetadata(scope: {
  readonly integrationId?: string;
  readonly hostId?: string;
  readonly supportedHostIds?: readonly string[];
  readonly configHash?: string;
}): boolean {
  return Boolean(
    scope.integrationId ||
    scope.hostId ||
    (scope.supportedHostIds && scope.supportedHostIds.length > 0) ||
    scope.configHash
  );
}

export function configHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function snippetForRouteAndPlatform(
  snippets: ReturnType<typeof generateVisibilitySetupSnippets>["platforms"],
  route: PlatformCommandSnippet["route"],
  platform: PlatformCommandSnippet["platform"]
): PlatformCommandSnippet | undefined {
  return snippets.find((snippet) => snippet.route === route && snippet.platform === platform);
}

function snippetCommand(snippets: ReturnType<typeof generateVisibilitySetupSnippets>["platforms"], id: string): string {
  return snippets.find((snippet) => snippet.id === id)?.command ?? "";
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
