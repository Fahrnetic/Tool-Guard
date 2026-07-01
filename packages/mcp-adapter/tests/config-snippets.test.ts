import { describe, expect, it } from "vitest";
import { generateHostConfigSnippets } from "../src/config-snippets.js";

describe("MCP host integration config snippets", () => {
  it("generates safe host-specific snippets with documented boundaries and limitations", () => {
    const snippets = generateHostConfigSnippets({
      toolplaneRepoPath: "<TOOLPLANE_REPO>",
      command: "node",
      serverModulePath: "<TOOLPLANE_REPO>/packages/mcp-adapter/dist/server.js"
    });

    expect(snippets.map((snippet) => snippet.hostId)).toEqual([
      "cline",
      "roo-code",
      "claude-desktop",
      "claude-code",
      "cursor",
      "windsurf",
      "codex-cli",
      "opencode",
      "hermes"
    ]);

    for (const snippet of snippets) {
      const serialized = JSON.stringify(snippet);
      expect(serialized).toContain("ToolGuard");
      expect(serialized).toContain("mcpServers");
      expect(serialized).toContain("<TOOLPLANE_REPO>");
      expect(serialized).toContain("<TOOLGUARD_PROFILE>");
      expect(serialized).toContain("MCP-routed-only card");
      expect(serialized).toContain("Native host tools and direct IDE actions are not intercepted");
      expect(serialized).toContain("stdio transport");
      expect(serialized).not.toMatch(/fixture\.(good|malformed-json|wrong-cwd|slow|hanging-stream)/);
      expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/);
      expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(serialized).not.toContain("3000");
      expect(serialized).not.toContain("5173");
    }
  });

  it("renders deterministic text output suitable for snapshot and secret scans", () => {
    const rendered = generateHostConfigSnippets({
      toolplaneRepoPath: "<TOOLPLANE_REPO>",
      command: "node",
      serverModulePath: "<TOOLPLANE_REPO>/packages/mcp-adapter/dist/server.js"
    })
      .map((snippet) => `${snippet.hostName}\n${snippet.transport}\n${snippet.configJson}\n${snippet.limitations.join("\n")}`)
      .join("\n---\n");

    expect(rendered).toContain("Cline");
    expect(rendered).toContain("Roo Code");
    expect(rendered).toContain("Claude Desktop");
    expect(rendered).toContain("Claude Code");
    expect(rendered).toContain("Cursor");
    expect(rendered).toContain("Windsurf");
    expect(rendered).toContain("Hermes");
    expect(rendered).toContain("Codex CLI");
    expect(rendered).toContain("OpenCode");
    expect(rendered).toContain("MCP-routed-only card");
    expect(rendered).toContain("stdio transport");
    expect(rendered).toMatch(/TOOLGUARD_CORE_URL[\s\S]+http:\/\/127\.0\.0\.1:3660/);
    expect(rendered).not.toMatch(/\/home\/|\/Users\/|[A-Z]:\\Users\\/);
  });
});
