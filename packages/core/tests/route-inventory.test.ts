import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_ROUTE_INVENTORY,
  README_ROUTE_CLAIM_MAPPINGS,
  generateHostConfigSnippets,
  generatePlatformCommandSnippets,
  type CanonicalRouteInventoryId
} from "../src/index.js";

describe("canonical README route inventory", () => {
  it("maps every README route claim excerpt to exactly one canonical inventory or non-claim entry", async () => {
    const readme = await readFile(path.join(process.cwd(), "../../README.md"), "utf8");
    const inventoryIds = new Set(CANONICAL_ROUTE_INVENTORY.map((entry) => entry.id));
    const claimIds = new Set<string>();

    for (const mapping of README_ROUTE_CLAIM_MAPPINGS) {
      expect(readme, `${mapping.claimId} README excerpt`).toContain(mapping.readmeText);
      expect(inventoryIds, `${mapping.claimId} inventory id`).toContain(mapping.inventoryId);
      expect(claimIds.has(mapping.claimId), `duplicate claim mapping ${mapping.claimId}`).toBe(false);
      claimIds.add(mapping.claimId);
    }

    const requiredInventoryIds: readonly CanonicalRouteInventoryId[] = [
      "direct-core-api",
      "mcp-routed",
      "cli-supervised",
      "sdk-wrapped-python",
      "js-ts-wrapper",
      "http-webhook-import",
      "browser-evidence-import",
      "visibility-jsonl-import",
      "otel-evidence-transport",
      "native-host-tools"
    ];
    expect(CANONICAL_ROUTE_INVENTORY.map((entry) => entry.id)).toEqual(requiredInventoryIds);
    for (const inventoryId of requiredInventoryIds) {
      expect(
        README_ROUTE_CLAIM_MAPPINGS.filter((mapping) => mapping.inventoryId === inventoryId),
        `${inventoryId} has a README claim mapping`
      ).not.toHaveLength(0);
    }
  });

  it("represents every README MCP host passport and preserves selected host metadata", () => {
    const mcpInventory = CANONICAL_ROUTE_INVENTORY.find((entry) => entry.id === "mcp-routed");
    const hosts = generateHostConfigSnippets();

    expect(mcpInventory?.mcpHostIds).toEqual(hosts.map((host) => host.hostId));
    for (const host of hosts) {
      expect(host.transport).toBe("stdio");
      expect(host.claimLevel).toBe("MCP-routed only");
      expect(host.limitations.join(" ")).toMatch(/native host tools|not intercepted/i);
      expect(JSON.parse(host.configJson)).toMatchObject({
        mcpServers: {
          toolguard: {
            command: "node",
            env: {
              TOOLGUARD_CORE_URL: "http://127.0.0.1:3660"
            }
          }
        }
      });
    }
  });

  it("normalizes setup snippet platform coverage and maps shell-api to direct Core/API", () => {
    const snippets = generatePlatformCommandSnippets();
    const platforms = [...new Set(snippets.map((snippet) => snippet.platform))].sort();
    expect(platforms).toEqual(["ci", "cmd", "container", "posix", "powershell", "wsl"]);

    const directInventory = CANONICAL_ROUTE_INVENTORY.find((entry) => entry.id === "direct-core-api");
    expect(directInventory).toMatchObject({
      setupSnippetRoutes: ["shell-api"],
      setupPlatforms: ["posix"],
      transports: ["in-process-core", "http-loopback-api"]
    });
    expect(snippets.filter((snippet) => snippet.route === "shell-api").map((snippet) => snippet.id)).toEqual(["shell-core-health"]);
    expect(snippets.find((snippet) => snippet.id === "mcp-container")).toMatchObject({
      platform: "container",
      route: "mcp-routed"
    });
    expect(CANONICAL_ROUTE_INVENTORY.find((entry) => entry.id === "mcp-routed")?.setupPlatforms).toContain("container");
  });

  it("categorizes Visibility JSONL and OpenTelemetry as transport evidence without mediated route overclaiming", () => {
    const jsonl = CANONICAL_ROUTE_INVENTORY.find((entry) => entry.id === "visibility-jsonl-import");
    const otel = CANONICAL_ROUTE_INVENTORY.find((entry) => entry.id === "otel-evidence-transport");

    expect(jsonl).toMatchObject({
      category: "evidence-transport",
      visibilityLevel: "imported",
      coverageClaim: "imported",
      evidenceScope: "transport",
      producesRouteEvidence: false
    });
    expect(otel).toMatchObject({
      category: "evidence-transport",
      visibilityLevel: "imported",
      coverageClaim: "imported",
      evidenceScope: "transport",
      producesRouteEvidence: false
    });
    expect([jsonl?.coverageClaim, otel?.coverageClaim]).not.toContain("mediated");
  });

  it("keeps Core protocol-independent by avoiding adapter, UI, and framework imports in source", async () => {
    const forbiddenImports = [
      "@modelcontextprotocol/",
      "react",
      "react-dom",
      "vite",
      "packages/ui",
      "packages/mcp-adapter",
      "langgraph",
      "crewai"
    ];
    const sourceFiles = ["src/index.ts", "src/route-inventory.ts", "src/server.ts", "src/visibility-interop.ts"];

    for (const sourceFile of sourceFiles) {
      const contents = await readFile(path.join(process.cwd(), sourceFile), "utf8");
      for (const forbiddenImport of forbiddenImports) {
        expect(contents, `${sourceFile} imports ${forbiddenImport}`).not.toContain(forbiddenImport);
      }
    }
  });
});
