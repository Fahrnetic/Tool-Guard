import type { ContextImpactMetrics, TokenEstimateConfidence } from "@toolplane/core";
import { StatusChip } from "./StatusChip.js";

interface ContextImpactBadgeProps {
  readonly impact: ContextImpactMetrics;
  readonly compact?: boolean;
}

export function ContextImpactBadge({ impact, compact = false }: ContextImpactBadgeProps) {
  const savedTokens = impact.preventedContextFlood.saved.estimatedTokens;
  const safeTokens = impact.safeDisplayedEstimate.estimatedTokens;
  const modelFacingTokens = impact.modelFacingContent.estimatedTokens;

  return (
    <section
      className="rounded-2xl border border-primary/30 bg-primary/10 p-4 shadow-lg shadow-black/10"
      aria-label="Estimated context impact"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            <StatusChip label="Estimated context impact" tone="selected" />
            <StatusChip label={`${impact.tokenEstimate.method}`} tone="neutral" />
            <StatusChip label={`${confidenceLabel(impact.tokenEstimate.confidence)} confidence`} tone={confidenceTone(impact.tokenEstimate.confidence)} />
          </div>
          <p className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-text">
            {formatNumber(impact.tokenEstimate.estimatedTokens)} tokens
          </p>
          <p className="mt-2 text-xs leading-5 text-text-muted">
            Provenance: {impact.tokenEstimate.provenance}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-bg/55 p-3 text-xs text-text-muted">
          <p className="font-semibold text-text">Safe aggregate metrics only</p>
          <p className="mt-1">Model-facing bytes: {formatNumber(impact.modelFacingContent.bytes)}</p>
          <p>Model-facing chars: {formatNumber(impact.modelFacingContent.chars)}</p>
        </div>
      </div>

      {!compact ? (
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Safe displayed" value={`${formatNumber(safeTokens)} tokens`} />
          <Metric label="Context flood prevented" value={`${formatNumber(savedTokens)} tokens saved`} />
          <Metric label="Redaction savings" value={`${formatNumber(impact.redactionSavings.estimatedTokens)} tokens`} />
          <Metric label="Retry amplification" value={`${formatNumber(impact.retryAmplification.contextMultiplier)}x context`} />
        </dl>
      ) : (
        <p className="mt-3 text-xs text-text-muted">
          Safe displayed: {formatNumber(safeTokens)} tokens, model-facing: {formatNumber(modelFacingTokens)} tokens, prevented flood:
          {" "}
          {formatNumber(savedTokens)} tokens saved.
        </p>
      )}
    </section>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg/55 p-3">
      <dt className="text-xs uppercase tracking-[0.18em] text-text-dim">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-text">{value}</dd>
    </div>
  );
}

function confidenceLabel(confidence: TokenEstimateConfidence): string {
  if (confidence === "high") return "High";
  if (confidence === "medium") return "Medium";
  return "Low";
}

function confidenceTone(confidence: TokenEstimateConfidence): "healthy" | "degraded" | "warning" {
  if (confidence === "high") return "healthy";
  if (confidence === "medium") return "degraded";
  return "warning";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
