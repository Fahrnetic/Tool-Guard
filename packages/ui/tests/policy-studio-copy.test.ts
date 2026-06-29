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

  it("uses report-export language instead of v0.10 bundle export claims", async () => {
    expect(harnessIntegrationsSource).toContain("ready for report export");
    expect(harnessIntegrationsSource).toContain("Report export ready");
    expect(harnessIntegrationsSource).toContain("Export receipts to report");
    expect(harnessIntegrationsSource).not.toContain("Evidence bundle export ready");
    expect(harnessIntegrationsSource).not.toContain("Export receipts to evidence bundle");
  });
});
