import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FailureTriage } from "../src/screens/FailureTriage.js";
import type { FailureTriagePayload } from "../src/lib/model.js";
import type { StableId } from "@toolplane/core";

describe("Diagnosis / Incident triage screen", () => {
  it("renders five answers, grouped fingerprint state, severity, next actions, and contained links", () => {
    const html = renderToStaticMarkup(<FailureTriage payload={payload} status="ready" />);

    expect(html).toContain("Failure triage that answers the incident questions");
    expect(html).toContain("Severity: high");
    expect(html).toContain("State: grouped");
    expect(html).toContain("2 occurrences");
    expect(html).toContain("what failed");
    expect(html).toContain("why");
    expect(html).toContain("impact");
    expect(html).toContain("waste");
    expect(html).toContain("next safe action");
    expect(html).toContain("Do not retry the identical call");
    expect(html).toContain("Topology links");
    expect(html).toContain("Timeline links");
    expect(html).toContain("Evidence links");
    expect(html).toContain("raw-stderr: artifact_stderr");
    expect(html).toContain("Export safe Markdown issue packet");
  });

  it("renders empty and degraded states", () => {
    const empty = renderToStaticMarkup(
      <FailureTriage
        payload={{ ...payload, groups: [], states: [], summary: { groups: 0, failures: 0, critical: 0, high: 0, medium: 0, low: 0 } }}
        status="ready"
      />
    );
    expect(empty).toContain("No incidents to triage");

    const degraded = renderToStaticMarkup(<FailureTriage status="degraded" error="Core triage endpoint unavailable" />);
    expect(degraded).toContain("Diagnosis partially unavailable");
    expect(degraded).toContain("Core triage endpoint unavailable");
  });
});

const payload: FailureTriagePayload = {
  runId: "run_triage",
  generatedAt: "2026-06-29T00:00:00.000Z",
  summary: { groups: 1, failures: 2, critical: 0, high: 1, medium: 0, low: 0 },
  states: ["grouped"],
  links: {
    topology: { artifactId: stableId("topology"), label: "Topology graph", href: "http://127.0.0.1:3660/api/topology/run_triage" },
    timeline: { artifactId: stableId("timeline"), label: "Timeline events", href: "http://127.0.0.1:3660/api/runs/latest" },
    evidenceBundle: { artifactId: stableId("evidence-bundle"), label: "Evidence bundle", href: "http://127.0.0.1:3660/api/bundle" }
  },
  groups: [
    {
      fingerprint: "fixture.triage:process_crash:process-crash:downstream:not-repeated",
      count: 2,
      lastOccurrence: "2026-06-29T00:00:01.000Z",
      severity: "high",
      state: "grouped",
      toolName: "fixture.triage",
      failureType: "process_crash",
      title: "HIGH fixture.triage process_crash",
      summary: "The fixture crashed.",
      answers: [
        { question: "what failed", answer: "fixture.triage failed with process_crash.", evidence: [] },
        { question: "why", answer: "The downstream process crashed.", evidence: [] },
        { question: "impact", answer: "Unknown impact, review side-effect ledger.", evidence: [] },
        { question: "waste", answer: "2 occurrence(s), 64 duplicate estimated tokens.", evidence: [] },
        { question: "next safe action", answer: "Do not retry the identical call.", evidence: [] }
      ],
      nextSafeActions: ["Do not retry the identical call until inputs, cwd, policy, or downstream health are changed."],
      topologyLinks: [{ artifactId: stableId("topology"), label: "Topology node links", href: "http://127.0.0.1:3660/api/topology/run_triage" }],
      timelineLinks: [{ artifactId: stableId("event_failed"), label: "Timeline event event_failed", href: "http://127.0.0.1:3660/api/runs/latest#event_failed" }],
      evidenceLinks: [{ artifactId: stableId("artifact_stderr"), label: "stderr", href: "http://127.0.0.1:3660/api/reports/run_triage/artifacts/artifact_stderr" }],
      rawArtifactLabels: ["raw-stderr: artifact_stderr"],
      issuePacketPreview: "## HIGH fixture.triage process_crash\n\n### Diagnosis\n\n- **what failed:** fixture.triage failed",
      factors: ["repeated failure fingerprint or retry loop"]
    }
  ]
};

function stableId(value: string): StableId {
  return value as StableId;
}
