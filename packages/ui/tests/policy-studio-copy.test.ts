import { describe, expect, it } from "vitest";
import harnessIntegrationsSource from "../src/screens/HarnessIntegrations.tsx?raw";
import policyStudioSource from "../src/screens/PolicyStudio.tsx?raw";

describe("policy simulator and integration copy safeguards", () => {
  it("clears stale policy simulation results before a new request and after request failures", async () => {
    const simulateBody = policyStudioSource.slice(
      policyStudioSource.indexOf("async function simulate()"),
      policyStudioSource.indexOf("  return (")
    );

    expect(simulateBody.indexOf("setSimulation(undefined);")).toBeLessThan(simulateBody.indexOf("setSimulationError(undefined);"));
    expect(simulateBody).toContain("} catch (caught) {\n      setSimulation(undefined);");
  });

  it("uses safe evidence bundle language with local receipts and visibility labels", async () => {
    expect(harnessIntegrationsSource).toContain("ready for evidence bundle export");
    expect(harnessIntegrationsSource).toContain("Safe evidence bundle ready");
    expect(harnessIntegrationsSource).toContain("Export safe evidence bundle");
    expect(harnessIntegrationsSource).toContain("Redacted visibility labels, route receipts, passports, and diagnostics are included.");
    expect(harnessIntegrationsSource).not.toContain("ready for report export");
    expect(harnessIntegrationsSource).not.toContain("Evidence bundle export ready");
    expect(harnessIntegrationsSource).not.toContain("Export receipts to evidence bundle");
  });
});
