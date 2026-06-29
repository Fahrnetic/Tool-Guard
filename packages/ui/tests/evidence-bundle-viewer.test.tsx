/// <reference types="node" />
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { EvidenceReportViewer } from "../src/screens/EvidenceReportViewer.js";
import type { BundlePayload, ReportsPayload } from "../src/lib/model.js";

describe("Evidence Bundle Viewer", () => {
  it("renders bundle health, loopback links, and print export controls", () => {
    const html = renderToStaticMarkup(
      <EvidenceReportViewer payload={reportsPayload} bundlePayload={bundlePayload} status="ready" />
    );

    expect(html).toContain("Evidence Bundle Viewer");
    expect(html).toContain("Manifest health");
    expect(html).toContain("Artifact hash status");
    expect(html).toContain("Redaction status");
    expect(html).toContain("Replay safety status");
    expect(html).toContain("Print and PDF export view");
    expect(html).toContain("Print or save PDF");
    expect(html).toContain("http://127.0.0.1:3660/api/bundles/run_bundle/files/manifest.json");
    expect(html).toContain("http://127.0.0.1:3660/api/bundles/run_bundle/files/manifest-validation.json");
    expect(html).not.toContain("file://");
  });

  it("defines print-friendly Tailwind theme variables for the bundle viewer", async () => {
    const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
    const printBlock = css.slice(css.indexOf("@media print"));

    expect(printBlock).toContain("--color-bg:");
    expect(printBlock).toContain("--color-bg-elevated:");
    expect(printBlock).toContain("--color-bg-panel:");
    expect(printBlock).toContain("--color-border:");
    expect(printBlock).toContain("--color-text:");
    expect(printBlock).toContain("--color-text-muted:");
    expect(printBlock).toContain("--color-text-dim:");
    expect(printBlock).toContain("--color-primary:");
    expect(printBlock).toContain("--color-success:");
    expect(printBlock).toContain("--color-warning:");
    expect(printBlock).toContain("--color-danger:");
  });
});

const bundlePayload: BundlePayload = {
  runId: "run_bundle",
  generatedAt: "2026-06-29T00:00:00.000Z",
  bundle: {
    exists: true,
    bundleId: "bundle-test",
    generatedAt: "2026-06-29T00:00:00.000Z",
    manifestJson: "/tmp/run/bundle/manifest.json",
    manifestUrl: "http://127.0.0.1:3660/api/bundles/run_bundle/files/manifest.json",
    manifestValidation: "/tmp/run/bundle/manifest-validation.json",
    manifestValidationUrl: "http://127.0.0.1:3660/api/bundles/run_bundle/files/manifest-validation.json",
    manifestValid: true,
    validationErrors: [],
    reportManifestValid: true,
    reportManifestErrors: [],
    replaySafe: true,
    replayReason: "fixture-only replay",
    replayInstructionsUrl: "http://127.0.0.1:3660/api/bundles/run_bundle/files/replay-instructions.json",
    files: [
      {
        key: "reportHtml",
        relativePath: "report.html",
        url: "http://127.0.0.1:3660/api/bundles/run_bundle/files/report.html",
        present: true,
        hashed: true,
        sha256: "a".repeat(64),
        byteLength: 128
      },
      {
        key: "manifestValidationJson",
        relativePath: "manifest-validation.json",
        url: "http://127.0.0.1:3660/api/bundles/run_bundle/files/manifest-validation.json",
        present: true,
        hashed: true,
        sha256: "d".repeat(64),
        byteLength: 32
      },
      {
        key: "artifactHashesJson",
        relativePath: "artifact-hashes.json",
        url: "http://127.0.0.1:3660/api/bundles/run_bundle/files/artifact-hashes.json",
        present: true,
        hashed: true,
        sha256: "b".repeat(64),
        byteLength: 64
      }
    ],
    rawArtifacts: [
      {
        relativePath: "evidence/raw-untrusted/artifact-raw-untrusted-stdout.txt",
        url: "http://127.0.0.1:3660/api/bundles/run_bundle/files/evidence/raw-untrusted/artifact-raw-untrusted-stdout.txt",
        sha256: "c".repeat(64),
        byteLength: 32
      }
    ],
    artifactHashes: [],
    redactionSummary: { redactionCount: 2, reasons: ["secret-shaped value redacted"] },
    manifestHealth: {
      status: "healthy",
      label: "Manifest valid",
      summary: "Bundle manifest references resolve."
    },
    artifactHashStatus: {
      status: "healthy",
      label: "12 hashed bundle files",
      summary: "All required bundle files include matching SHA-256 entries."
    },
    redactionStatus: {
      status: "healthy",
      label: "2 redactions recorded",
      summary: "secret-shaped value redacted"
    },
    replaySafetyStatus: {
      status: "healthy",
      label: "Replay instructions safe",
      summary: "fixture-only replay"
    }
  }
};

const reportsPayload: ReportsPayload = {
  runId: "run_bundle",
  generatedAt: "2026-06-29T00:00:00.000Z",
  reports: []
};
