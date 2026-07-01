import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessIntegrations } from "../src/screens/HarnessIntegrations.js";
import { exportBundle, verifyIntegration } from "../src/lib/api.js";
import type { IntegrationView, IntegrationsPayload, VerificationReceipt } from "../src/lib/model.js";

declare global {
  // React uses this flag to verify act() coverage in non-browser test environments.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.mock("../src/lib/api.js", () => ({
  verifyIntegration: vi.fn(),
  exportBundle: vi.fn()
}));

describe("Harness Integrations workbench interactions", () => {
  let root: Root | undefined;
  let dom: JSDOM | undefined;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = undefined;
    dom = undefined;
    vi.mocked(verifyIntegration).mockReset();
    vi.mocked(exportBundle).mockReset();
  });

  it("switches harness and platform selectors while keeping receipts scoped to the exact passport", async () => {
    vi.mocked(verifyIntegration).mockResolvedValue(clineReceipt);
    vi.mocked(exportBundle).mockResolvedValue({
      runId: "run_integrations",
      bundleDir: "/tmp/toolguard/run_integrations/bundle",
      manifestJson: "/tmp/toolguard/run_integrations/bundle/manifest.json",
      manifestUrl: "http://127.0.0.1:3660/api/bundle/files/manifest.json",
      manifestValidation: "/tmp/toolguard/run_integrations/bundle/manifest-validation.json",
      manifestValidationUrl: "http://127.0.0.1:3660/api/bundle/files/manifest-validation.json",
      manifestValid: true,
      validationErrors: [],
      replayInstructions: "/tmp/toolguard/run_integrations/bundle/replay-instructions.json",
      replayInstructionsUrl: "http://127.0.0.1:3660/api/bundle/files/replay-instructions.json"
    });
    renderWorkbench();

    expect(selectedSnippetText()).toContain("# Cline (cline-roo-style)");
    expect(selectedSnippetText()).toContain('"autoApprove": []');

    await clickProbe();
    expect(selectedWizardText()).toContain("Cline-specific virtual routed tool evidence probe");
    expect(selectedWizardText()).toContain("Coverage passport");
    expect(selectedWizardText()).toContain("Friendly diagnostic record");
    expect(selectedWizardText()).toContain("Native host file edit");
    expect(selectedWizardText()).toContain("not-covered");

    changeSelect("Choose harness", "roo-code");
    expect(selectedSnippetText()).toContain("# Roo Code (cline-roo-style)");
    expect(selectedSnippetText()).toContain('"alwaysAllow": []');
    expect(selectedSnippetText()).not.toContain('"autoApprove": []');
    expect(selectedWizardText()).toContain("No receipt for this route");
    expect(selectedWizardText()).not.toContain("Cline-specific virtual routed tool evidence probe");

    changeSelect("Choose platform", "powershell");
    expect(selectedSnippetText()).toContain("$env:TOOLGUARD_CORE_URL = 'http://127.0.0.1:3660'");
    expect(selectedSnippetText()).toContain('"alwaysAllow": []');

    changeSelect("Choose harness", "cline");
    expect(selectedSnippetText()).toContain("# Cline (cline-roo-style)");
    expect(selectedSnippetText()).toContain("$env:TOOLGUARD_CORE_URL = 'http://127.0.0.1:3660'");
    expect(selectedWizardText()).toContain("Cline-specific virtual routed tool evidence probe");

    await clickExportBundle();
    expect(vi.mocked(exportBundle)).toHaveBeenCalledTimes(1);
    expect(dom?.window.document.body.textContent).toContain("Safe evidence bundle ready: manifest valid");
    expect(dom?.window.document.body.textContent).toContain("Redacted visibility labels, route receipts, passports, and diagnostics are included.");
  });

  function renderWorkbench(): void {
    dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
      url: "http://127.0.0.1:3661"
    });
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(dom.window.document.getElementById("root")!);
    act(() => {
      root?.render(<HarnessIntegrations payload={payload} status="ready" />);
    });
  }

  function changeSelect(label: string, value: string): void {
    const select = dom?.window.document.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    act(() => {
      select!.value = value;
      select!.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));
    });
  }

  async function clickProbe(): Promise<void> {
    const button = Array.from(dom!.window.document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Run verification probe")
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true }));
    });
  }

  async function clickExportBundle(): Promise<void> {
    const button = Array.from(dom!.window.document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Export safe evidence bundle")
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true }));
    });
  }

  function selectedSnippetText(): string {
    return dom?.window.document.querySelector("[data-testid='selected-setup-snippet']")?.textContent ?? "";
  }

  function selectedWizardText(): string {
    return dom?.window.document.querySelector("[data-testid='selected-harness-wizard']")?.textContent ?? "";
  }
});

const payload: IntegrationsPayload = {
  runId: "run_integrations",
  generatedAt: "2026-07-01T00:00:00.000Z",
  routeCoverage: [
    {
      routeType: "mcp-routed",
      label: "MCP routed adapter path",
      claim: "mediated",
      configured: true,
      available: true,
      evidenceFreshness: "recent",
      lastEvidenceAt: "2026-07-01T00:00:00.000Z",
      limitation: "Covered only when calls route through the ToolGuard MCP proxy.",
      checks: [{ label: "adapter availability", state: "available", evidence: "Route-level MCP receipt recorded." }]
    }
  ],
  integrations: [
    mcpIntegration("cline", "Cline", ["cline"]),
    mcpIntegration("roo-code", "Roo Code", ["roo-code"])
  ]
};

const clineReceipt: VerificationReceipt = {
  receiptId: "receipt_cline",
  runId: "run_integrations",
  timestamp: "2026-07-01T00:05:00.000Z",
  routeType: "mcp-routed",
  smokeTestStatus: "passed",
  visibilityLevel: "mediated",
  hostId: "cline",
  hostFamily: "cline-roo-style",
  osPlatform: "linux",
  osFamily: "linux",
  transport: "stdio",
  configHash: "fnv1a-cline",
  supportedHostIds: ["cline"],
  platformPassport: {
    passportId: "passport_cline",
    hostId: "cline",
    hostName: "Cline",
    osPlatform: "linux",
    osFamily: "linux",
    transport: "stdio",
    routeType: "mcp-routed",
    configHash: "fnv1a-cline",
    visibilityLevel: "mediated",
    limitations: ["Native host tools remain not-covered unless routed through ToolGuard."],
    evidenceFields: ["receiptId", "routeType", "checkedCapabilities", "evidenceLinks"],
    smokeTestStatus: "passed",
    lastVerifiedAt: "2026-07-01T00:05:00.000Z"
  },
  nativeHostActions: [
    {
      action: "Native host file edit",
      coverage: "not-covered",
      limitation: "Bypasses the ToolGuard MCP route and is not claimed as protected."
    }
  ],
  checkedCapabilities: [
    {
      capability: "virtual routed tool evidence",
      status: "available",
      localOnly: true,
      evidence: "Cline-specific virtual routed tool evidence probe passed."
    }
  ],
  routeCoverage: [
    {
      state: "producing-evidence",
      label: "MCP routed adapter path producing evidence",
      localOnly: true,
      evidence: "The Cline host-specific route produced evidence."
    }
  ],
  limitation: "Local-only MCP verification checks calls routed through ToolGuard MCP configuration only.",
  evidenceLinks: []
};

function mcpIntegration(id: string, name: string, supportedHostIds: readonly string[]): IntegrationView {
  return {
    id,
    name,
    route: "MCP-routed",
    claimLevel: "not-yet-verified",
    status: "not-yet-verified",
    supportedHostIds,
    hostFamily: "cline-roo-style",
    limitation: "ToolGuard protects calls routed through the MCP proxy only, not native host tools."
  };
}
