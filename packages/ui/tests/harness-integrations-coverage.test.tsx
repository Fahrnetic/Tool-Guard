import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HarnessIntegrations,
  mcpHostIdsForIntegration,
  receiptMatchesIntegration,
  setupSnippetFor
} from "../src/screens/HarnessIntegrations.js";
import type { IntegrationView, IntegrationsPayload, VerificationReceipt } from "../src/lib/model.js";

describe("Harness Integrations coverage matrix", () => {
  it("renders coverage honesty labels and warnings when recent evidence is missing", () => {
    const html = renderToStaticMarkup(<HarnessIntegrations payload={payload} status="ready" />);

    expect(html).toContain("Route-first onboarding");
    expect(html).toContain("Start with what ToolGuard can actually see");
    expect(html).toContain("mediated");
    expect(html).toContain("supervised");
    expect(html).toContain("observed");
    expect(html).toContain("imported");
    expect(html).toContain("unknown");
    expect(html).toContain("Choose harness");
    expect(html).toContain("Choose platform");
    expect(html).toContain("Guided setup checklist");
    expect(html).toContain("Copy setup snippet");
    expect(html).toContain("Smoke-test receipt status");
    expect(html).toContain("Warning. No local smoke-test receipt is visible yet");
    expect(html).toContain("Harness passports");
    expect(html).toContain("Evidence fields");
    expect(html).toContain("Limitations");
    expect(html).toContain("No exact harness proof yet");
    expect(html).toContain("Route coverage matrix");
    expect(html).toContain("mediated");
    expect(html).toContain("supervised");
    expect(html).toContain("observed");
    expect(html).toContain("not-covered");
    expect(html).toContain("no recent evidence");
    expect(html).toContain("No recent evidence has been recorded");
    expect(html).toContain("Native host tools remain outside the claim");
  });

  it("does not project route-level MCP freshness onto harness passports", () => {
    const html = renderToStaticMarkup(<HarnessIntegrations payload={payloadWithRecentProof} status="ready" />);

    expect(html).toContain("Warning. Route-level MCP evidence exists, but no exact harness passport receipt matched");
    expect(html).toContain("Exact harness receipt: not verified");
    expect(html).toContain("Route-level MCP evidence was not projected onto this host passport");
    expect(html).toContain("No exact harness proof yet");
    expect(html).toContain("unsupported");
    expect(html).toContain("not-covered");
    expect(html).toContain("ToolGuard does not claim native host interception");
    expect(html).toContain("Last verified");
    expect(html).toContain("adapter availability");
  });

  it("switches MCP harness selections to host-specific setup snippets", () => {
    const clineSnippet = setupSnippetFor(mcpIntegration("cline", "Cline"), "posix").command;
    const rooSnippet = setupSnippetFor(mcpIntegration("roo-code", "Roo Code"), "posix").command;
    const claudeSnippet = setupSnippetFor(mcpIntegration("claude-desktop-code", "Claude Desktop / Code"), "posix").command;
    const cursorSnippet = setupSnippetFor(mcpIntegration("cursor-windsurf", "Cursor / Windsurf"), "posix").command;

    expect(clineSnippet).toContain("# Cline (cline-roo-style)");
    expect(clineSnippet).toContain('"autoApprove": []');
    expect(clineSnippet).not.toContain('"alwaysAllow": []');
    expect(rooSnippet).toContain("# Roo Code (cline-roo-style)");
    expect(rooSnippet).toContain('"alwaysAllow": []');
    expect(rooSnippet).not.toContain('"autoApprove": []');
    expect(mcpHostIdsForIntegration(mcpIntegration("claude-desktop-code", "Claude Desktop / Code"))).toEqual([
      "claude-desktop",
      "claude-code"
    ]);
    expect(claudeSnippet).toContain("# Claude Desktop (claude-style)");
    expect(claudeSnippet).toContain("# Claude Code (claude-style)");
    expect(cursorSnippet).toContain("# Cursor (cursor-windsurf-style)");
    expect(cursorSnippet).toContain("# Windsurf (cursor-windsurf-style)");
  });

  it("switches platform snippets while preserving selected route setup", () => {
    const cliPowerShell = setupSnippetFor(cliIntegration, "powershell").command;
    const cliCmd = setupSnippetFor(cliIntegration, "cmd").command;
    const rooPosix = setupSnippetFor(mcpIntegration("roo-code", "Roo Code"), "posix").command;
    const rooPowerShell = setupSnippetFor(mcpIntegration("roo-code", "Roo Code"), "powershell").command;

    expect(cliPowerShell).toContain("toolguard run --evidence-root '<TOOLGUARD_EVIDENCE_DIR>'");
    expect(cliPowerShell).not.toContain('toolguard run --evidence-root "<TOOLGUARD_EVIDENCE_DIR>"');
    expect(cliCmd).toContain('toolguard run --evidence-root "<TOOLGUARD_EVIDENCE_DIR>"');
    expect(rooPosix).toContain("TOOLGUARD_CORE_URL='http://127.0.0.1:3660' \\");
    expect(rooPowerShell).toContain("$env:TOOLGUARD_CORE_URL = 'http://127.0.0.1:3660'");
    expect(rooPowerShell).toContain('"alwaysAllow": []');
  });

  it("matches passport evidence only when the receipt identifies the exact MCP harness, family, or config", () => {
    const cline = mcpIntegration("cline", "Cline");
    const roo = mcpIntegration("roo-code", "Roo Code");
    const clineReceipt = receiptFor({ hostId: "cline" });
    const routeOnlyReceipt = receiptFor({});
    const familyReceipt = receiptFor({ hostFamily: "cline-roo-style" });

    expect(receiptMatchesIntegration(clineReceipt, cline)).toBe(true);
    expect(receiptMatchesIntegration(clineReceipt, roo)).toBe(false);
    expect(receiptMatchesIntegration(routeOnlyReceipt, cline)).toBe(false);
    expect(receiptMatchesIntegration(familyReceipt, roo)).toBe(true);
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
      supportedHostIds: ["cline"],
      hostFamily: "cline-roo-style",
      limitation: "ToolGuard protects calls routed through the MCP proxy only, not native host tools."
    }
  ]
};

const payloadWithRecentProof: IntegrationsPayload = {
  ...payload,
  routeCoverage: [
    {
      routeType: "mcp-routed",
      label: "MCP routed adapter path",
      claim: "mediated",
      configured: true,
      available: true,
      evidenceFreshness: "recent",
      lastEvidenceAt: "2026-06-29T01:00:00.000Z",
      limitation: "Covered only when calls route through the ToolGuard MCP proxy.",
      checks: [{ label: "adapter availability", state: "available", evidence: "Receipt recorded." }]
    },
    ...payload.routeCoverage!.slice(1)
  ],
  integrations: [
    ...payload.integrations,
    {
      id: "native-host-tools",
      name: "Unrouted native host tools",
      route: "unsupported",
      claimLevel: "unsupported",
      status: "unsupported",
      limitation: "ToolGuard does not claim native host interception for unrouted host tools."
    }
  ]
};

const cliIntegration: IntegrationView = {
  id: "aider-crush",
  name: "Aider / Crush-style CLIs",
  route: "CLI-supervised",
  claimLevel: "not-yet-verified",
  status: "not-yet-verified",
  limitation: "Process-level supervision only unless a stable native tool-router boundary is proven."
};

function mcpIntegration(id: string, name: string): IntegrationView {
  return {
    id,
    name,
    route: "MCP-routed",
    claimLevel: "not-yet-verified",
    status: "not-yet-verified",
    limitation: "ToolGuard protects calls routed through the MCP proxy only, not native host tools."
  };
}

function receiptFor(scope: Partial<Pick<VerificationReceipt, "hostId" | "hostFamily" | "supportedHostIds" | "configHash">>): VerificationReceipt {
  return {
    receiptId: "receipt_test",
    runId: "run_test",
    timestamp: "2026-06-29T02:00:00.000Z",
    routeType: "mcp-routed",
    ...scope,
    checkedCapabilities: [
      {
        capability: "virtual routed tool evidence",
        status: "available",
        localOnly: true,
        evidence: "Exact receipt test evidence."
      }
    ],
    routeCoverage: [
      {
        state: "producing-evidence",
        label: "MCP routed adapter path producing evidence",
        localOnly: true,
        evidence: "Route receipt emitted."
      }
    ],
    limitation: "MCP routed only.",
    evidenceLinks: []
  };
}
