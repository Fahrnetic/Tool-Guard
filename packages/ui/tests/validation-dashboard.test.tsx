import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ValidationDashboard } from "../src/screens/ValidationDashboard.js";
import type { ValidationDashboardPayload } from "../src/lib/model.js";

describe("Validation Dashboard", () => {
  it("renders local gate checks with pass, fail, and warn indicators", () => {
    const html = renderToStaticMarkup(<ValidationDashboard payload={payload} status="ready" />);

    expect(html).toContain("Validation Dashboard");
    expect(html).toContain("Tests");
    expect(html).toContain("Typecheck");
    expect(html).toContain("Lint");
    expect(html).toContain("Demo readiness");
    expect(html).toContain("Evidence export");
    expect(html).toContain("No-secret scan");
    expect(html).toContain("Process hygiene");
    expect(html).toContain("pass");
    expect(html).toContain("warn");
    expect(html).toContain("fail");
    expect(html).toContain("ledgers, topology labels, narratives, bundle metadata, and story text");
    expect(html).toContain("ports 3660-3669");
  });
});

const payload: ValidationDashboardPayload = {
  runId: "run_demo_flagship_seed_v011",
  generatedAt: "2026-06-29T00:00:00.000Z",
  deterministicSeed: "toolguard-flagship-demo-v0.11",
  approvedPorts: [3660, 3661, 3662, 3663, 3664, 3665, 3666, 3667, 3668, 3669],
  artifactCoverage: {
    ledger: true,
    topology: true,
    narrative: true,
    report: true,
    manifest: true,
    bundleManifest: false
  },
  checks: [
    { id: "tests", label: "Tests", status: "warn", detail: "Run pnpm test." },
    { id: "typecheck", label: "Typecheck", status: "pass", detail: "Typecheck passed." },
    { id: "lint", label: "Lint", status: "pass", detail: "Lint passed." },
    { id: "demo-readiness", label: "Demo readiness", status: "pass", detail: "Demo evidence is ready." },
    { id: "evidence-export", label: "Evidence export", status: "fail", detail: "Bundle manifest missing." },
    { id: "no-secret-scan", label: "No-secret scan", status: "pass", detail: "No findings." },
    { id: "process-hygiene", label: "Process hygiene", status: "pass", detail: "Approved ports only." }
  ]
};
