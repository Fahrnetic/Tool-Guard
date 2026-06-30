import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessIntegrations } from "../src/screens/HarnessIntegrations.js";
import type { IntegrationsPayload } from "../src/lib/model.js";

describe("Harness Integrations coverage matrix", () => {
  it("renders coverage honesty labels and warnings when recent evidence is missing", () => {
    const html = renderToStaticMarkup(<HarnessIntegrations payload={payload} status="ready" />);

    expect(html).toContain("Route coverage matrix");
    expect(html).toContain("mediated");
    expect(html).toContain("supervised");
    expect(html).toContain("observed");
    expect(html).toContain("not-covered");
    expect(html).toContain("no recent evidence");
    expect(html).toContain("No recent evidence has been recorded");
    expect(html).toContain("Native host tools remain outside the claim");
  });
});

const payload: IntegrationsPayload = {
  runId: "run_integrations",
  generatedAt: "2026-06-29T00:00:00.000Z",
  routeCoverage: [
    {
      routeType: "mcp-routed",
      label: "MCP routed adapter path",
      claim: "mediated",
      configured: false,
      available: false,
      evidenceFreshness: "missing",
      warning: "No recent evidence has been recorded for this configured route in the active Core session.",
      limitation: "Covered only when calls route through the ToolGuard MCP proxy. Native host tools remain outside the claim.",
      checks: [{ label: "Evidence receipt", state: "not-verified", evidence: "No integration.verified receipt is present." }]
    },
    {
      routeType: "cli-supervised",
      label: "CLI supervised process path",
      claim: "supervised",
      configured: true,
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
      configured: true,
      available: true,
      evidenceFreshness: "recent",
      lastEvidenceAt: "2026-06-29T00:00:00.000Z",
      limitation: "Observed only for explicit wrapper and loopback sidecar usage.",
      checks: [{ label: "Route check", state: "available", evidence: "Receipt recorded." }]
    },
    {
      routeType: "native-host-tools",
      label: "Unrouted native host tools",
      claim: "not-covered",
      configured: false,
      available: false,
      evidenceFreshness: "missing",
      warning: "Not covered. Route calls through MCP, SDK wrappers, CLI shim, or ToolGuard API before claiming protection.",
      limitation: "ToolGuard does not claim native host interception for unrouted host tools.",
      checks: [{ label: "Coverage claim", state: "not-covered", evidence: "No routed boundary exists." }]
    }
  ],
  integrations: [
    {
      id: "cline",
      name: "Cline",
      route: "MCP-routed",
      claimLevel: "available",
      status: "available",
      limitation: "ToolGuard protects calls routed through the MCP proxy only, not native host tools."
    }
  ]
};
