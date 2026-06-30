import { CorrelationGrid } from "../components/CorrelationGrid.js";
import { ContextImpactBadge } from "../components/ContextImpactBadge.js";
import { StatePanel } from "../components/StatePanel.js";
import { StatusChip } from "../components/StatusChip.js";
import { selectionMatchesValues, type FailureCardView, type FailureInboxPayload, type RawArtifactView, type ResourceStatus, type TopologySelection } from "../lib/model.js";

interface FailureInboxProps {
  readonly payload?: FailureInboxPayload;
  readonly status: ResourceStatus;
  readonly error?: string;
  readonly topologySelection?: TopologySelection;
}

export function FailureInbox({ payload, status, error, topologySelection }: FailureInboxProps) {
  if (status === "loading") {
    return <StatePanel status="loading" title="Loading Failure Inbox" message="Fetching model-safe Failure Cards from `/api/failures`." />;
  }
  if (status === "error") {
    return <StatePanel status="error" title="Failure Inbox unavailable" message={error ?? "Core did not return failures."} />;
  }
  if (!payload || payload.failures.length === 0) {
    return (
      <StatePanel
        status="empty"
        title="No Failure Cards"
        message="No mediated failures have been recorded yet."
        action="Run a failing fixture to populate model-safe Failure Cards."
      />
    );
  }

  return (
    <section className="space-y-5">
      <div className="rounded-3xl border border-border bg-bg-elevated/80 p-6">
        <StatusChip label="Failure Inbox, model-safe by default" tone="selected" />
        <h2 className="mt-3 text-2xl font-semibold text-text">Failure Cards with raw output kept separate</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
          Safe summaries, retry guidance, recovery options, human fixes, evidence links, and correlation IDs are visible
          without mixing raw stdout or stderr into model-facing fields.
        </p>
      </div>

      {payload.failures.map((failure) => {
        const highlighted = selectionMatchesValues(topologySelection, [
          failure.eventId,
          failure.correlation.traceId,
          failure.correlation.toolCallId,
          failure.correlation.attemptId,
          failure.correlation.policyDecisionId,
          ...failure.evidenceLinks.map((link) => link.artifactId)
        ]);
        return (
        <article key={failure.eventId} className={`rounded-2xl border p-5 shadow-2xl shadow-black/20 ${highlighted ? "border-primary bg-primary/10" : "border-border bg-bg-panel/90"}`}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap gap-2">
                <StatusChip label={failure.failureType} tone={failure.retryable ? "degraded" : "failed"} />
                <StatusChip label={failure.retryable ? "retryable by policy" : "same-call retry suppressed"} tone={failure.retryable ? "degraded" : "failed"} />
                {failure.sanitizedEvents.length > 0 ? <StatusChip label="output.sanitized" tone="degraded" /> : null}
              </div>
              <h3 className="mt-3 text-xl font-semibold text-text">{failure.toolName}</h3>
              <p className="mt-2 text-sm leading-6 text-text-muted">{failure.safeSummary}</p>
            </div>
            <time className="font-mono text-xs text-text-dim">{failure.occurredAt}</time>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <InfoBlock title="Likely root cause" body={failure.likelyRootCause} />
            <InfoBlock title="Failure mechanism" body={failure.failureMechanism} />
            <InfoBlock title="Human fix" body={failure.humanFix ?? "No human fix required. Follow safe recovery options."} />
            <InfoBlock title="Same-call retry guidance" body={failure.doNotRetrySameCall ? "Do not retry the same call. Change recovery action first." : "Same-call retry may be allowed by policy."} />
            <div className="rounded-xl border border-border bg-bg/55 p-4">
              <h4 className="text-sm font-semibold text-text">Safe recovery options</h4>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-muted">
                {failure.safeRecoveryOptions.map((option) => (
                  <li key={option}>{option}</li>
                ))}
              </ul>
            </div>
          </div>

          <DiagnosisPanel failure={failure} />

          <div className="mt-5">
            <ContextImpactBadge impact={failure.contextImpact} />
          </div>

          <div className="mt-5">
            <h4 className="text-sm font-semibold text-text">Evidence links</h4>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {failure.evidenceLinks.map((link) => (
                <a key={link.artifactId} href={link.href} className="rounded-xl border border-border bg-bg/55 p-3 font-mono text-xs text-primary hover:border-primary/50 focus-visible:border-primary">
                  {link.label}: {link.artifactId}
                </a>
              ))}
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-3" aria-label="Raw output separation">
            <RawPane title="Sanitized model-safe summary" body={failure.safeSummary} />
            <RawPane title="Raw stdout, intentional inspection" body={describeArtifacts(failure.rawStdout, "No raw stdout artifact linked to this failure.")} />
            <RawPane title="Raw stderr, intentional inspection" body={describeArtifacts(failure.rawStderr, "No raw stderr artifact linked to this failure.")} />
          </div>

          <div className="mt-5">
            <h4 className="mb-2 text-sm font-semibold text-text">Correlation IDs</h4>
            <CorrelationGrid correlation={failure.correlation} />
          </div>
        </article>
        );
      })}
    </section>
  );
}

function DiagnosisPanel({ failure }: { readonly failure: FailureCardView }) {
  const rankedHypotheses = [...failure.diagnosticHypotheses].sort((left, right) => left.rank - right.rank);

  return (
    <section className="mt-5 rounded-2xl border border-border bg-bg/55 p-5" aria-labelledby={`${failure.eventId}-diagnosis`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <StatusChip label="Root-cause diagnosis" tone="selected" />
          <h4 id={`${failure.eventId}-diagnosis`} className="mt-3 text-lg font-semibold text-text">
            Ranked diagnostic hypotheses
          </h4>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
            Hypotheses are inferred from separated evidence. Low-confidence items are marked as weak inference and are not
            presented as fact.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusChip label={`Overall confidence: ${confidenceLabel(failure.rootCauseConfidence)}`} tone={confidenceTone(failure.rootCauseConfidence)} />
          <StatusChip label={`Boundary: ${failure.failureBoundary}`} tone="neutral" />
          <StatusChip label={`Cause: ${failure.failureCause}`} tone="neutral" />
        </div>
      </div>

      {failure.contributingFactors.length > 0 ? (
        <div className="mt-4 rounded-xl border border-border bg-bg-panel/70 p-4">
          <h5 className="text-sm font-semibold text-text">Contributing factors</h5>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-muted">
            {failure.contributingFactors.map((factor) => (
              <li key={factor}>{factor}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3">
        {rankedHypotheses.map((hypothesis) => {
          const anchors = hypothesis.evidenceAnchorIds
            .map((anchorId) => failure.evidenceAnchors.find((anchor) => anchor.anchorId === anchorId))
            .filter((anchor): anchor is FailureCardView["evidenceAnchors"][number] => Boolean(anchor));
          return (
            <article key={`${failure.eventId}-${hypothesis.rank}-${hypothesis.cause}`} className="rounded-xl border border-border bg-bg-panel/80 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap gap-2">
                    <StatusChip label={`Rank ${hypothesis.rank}`} tone="selected" />
                    <StatusChip label={confidenceLabel(hypothesis.confidence)} tone={confidenceTone(hypothesis.confidence)} />
                    {hypothesis.confidence === "low" ? <StatusChip label="Weak inference, not fact" tone="warning" /> : null}
                  </div>
                  <h5 className="mt-3 text-base font-semibold text-text">
                    {hypothesis.cause} at {hypothesis.boundary} boundary
                  </h5>
                  <p className="mt-2 text-sm leading-6 text-text-muted">{hypothesis.mechanism}</p>
                  {hypothesis.confidence === "low" ? (
                    <p className="mt-2 rounded-lg border border-warning/35 bg-warning/10 p-2 text-xs font-semibold text-warning">
                      This is a weak inference. Treat it as a lead to verify, not as established root cause.
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2" aria-label={`Evidence anchors for ranked hypothesis ${hypothesis.rank}`}>
                {anchors.length > 0 ? (
                  anchors.map((anchor) => (
                    <a
                      key={anchor.anchorId}
                      href={anchorHref(anchor, failure)}
                      className="rounded-lg border border-border bg-bg px-3 py-2 text-xs font-semibold text-primary transition hover:border-primary/50 hover:bg-primary/10 focus-visible:border-primary"
                    >
                      {anchor.label} ({anchor.evidenceType}, {confidenceLabel(anchor.confidenceContribution)})
                    </a>
                  ))
                ) : (
                  <span className="text-xs text-text-dim">No direct anchors linked to this hypothesis.</span>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2">
        {failure.evidenceAnchors.map((anchor) => (
          <a
            id={anchor.anchorId}
            key={anchor.anchorId}
            href={anchorHref(anchor, failure)}
            className="rounded-xl border border-border bg-bg p-3 transition hover:border-primary/45 hover:bg-primary/5 focus-visible:border-primary"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-primary">{anchor.anchorId}</span>
              <StatusChip label={anchor.evidenceType} tone="neutral" />
              <StatusChip label={confidenceLabel(anchor.confidenceContribution)} tone={confidenceTone(anchor.confidenceContribution)} />
            </div>
            <p className="mt-2 text-sm font-semibold text-text">{anchor.label}</p>
            <p className="mt-1 text-xs leading-5 text-text-muted">{anchor.summary}</p>
          </a>
        ))}
      </div>
    </section>
  );
}

function InfoBlock({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg/55 p-4">
      <h4 className="text-sm font-semibold text-text">{title}</h4>
      <p className="mt-2 text-sm leading-6 text-text-muted">{body}</p>
    </div>
  );
}

function RawPane({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <section className="min-h-32 rounded-xl border border-border bg-bg p-4">
      <h4 className="text-sm font-semibold text-text">{title}</h4>
      <pre className="mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-text-muted">{body}</pre>
    </section>
  );
}

function confidenceLabel(confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") return "High confidence";
  if (confidence === "medium") return "Medium confidence";
  return "Low confidence";
}

function confidenceTone(confidence: "high" | "medium" | "low"): "healthy" | "degraded" | "warning" {
  if (confidence === "high") return "healthy";
  if (confidence === "medium") return "degraded";
  return "warning";
}

function anchorHref(anchor: FailureCardView["evidenceAnchors"][number], failure: FailureCardView): string {
  if (anchor.href) return anchor.href;
  if (anchor.artifactId) {
    return failure.evidenceLinks.find((link) => link.artifactId === anchor.artifactId)?.href ?? `#${anchor.anchorId}`;
  }
  return `#${anchor.anchorId}`;
}

function describeArtifacts(artifacts: readonly RawArtifactView[], empty: string): string {
  if (artifacts.length === 0) return empty;
  return artifacts.map((artifact) => [
    `${artifact.artifactId}`,
    `${artifact.relativePath}`,
    `${artifact.byteLength} bytes${artifact.outputLimitBytes ? `, output limit ${artifact.outputLimitBytes} bytes` : ""}`,
    `redacted=${artifact.redacted}`,
    `truncated=${artifact.truncated}`,
    "",
    artifact.contentUnavailable ? `Content unavailable: ${artifact.contentUnavailable}` : artifact.content
  ].join("\n")).join("\n\n");
}
