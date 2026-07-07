import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("policy simulator and integration copy safeguards", () => {
  it("clears stale policy simulation results before a new request and after request failures", async () => {
    const policyStudioSource = await readFile(new URL("../src/screens/PolicyStudio.tsx", import.meta.url), "utf8");
    const simulateStart = policyStudioSource.indexOf("async function simulate()");
    const simulateBody = policyStudioSource.slice(simulateStart, policyStudioSource.indexOf("  return (", simulateStart));

    expect(simulateBody.indexOf("setSimulation(undefined);")).toBeLessThan(simulateBody.indexOf("setSimulationError(undefined);"));
    expect(simulateBody).toContain("} catch (caught) {\n      setSimulation(undefined);");
  });

  it("uses safe evidence bundle language with local receipts and visibility labels", async () => {
    const harnessIntegrationsSource = await readFile(new URL("../src/screens/HarnessIntegrations.tsx", import.meta.url), "utf8");

    expect(harnessIntegrationsSource).toContain("ready for evidence bundle export");
    expect(harnessIntegrationsSource).toContain("Safe evidence bundle ready");
    expect(harnessIntegrationsSource).toContain("Export safe evidence bundle");
    expect(harnessIntegrationsSource).toContain("Redacted visibility labels, route receipts, passports, and diagnostics are included.");
    expect(harnessIntegrationsSource).not.toContain("ready for report export");
    expect(harnessIntegrationsSource).not.toContain("Evidence bundle export ready");
    expect(harnessIntegrationsSource).not.toContain("Export receipts to evidence bundle");
  });
});
