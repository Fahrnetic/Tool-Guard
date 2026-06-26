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
      "hermes"
    ]);

    for (const snippet of snippets) {
      const serialized = JSON.stringify(snippet);
      expect(serialized).toContain("ToolGuard");
      expect(serialized).toContain("mcpServers");
      expect(serialized).toContain("<TOOLPLANE_REPO>");
      expect(serialized).toContain("<TOOLGUARD_PROFILE>");
      expect(serialized).toContain("Native host tools are not intercepted");
      expect(serialized).toContain("direct downstream fixtures");
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
    expect(rendered).toMatchInlineSnapshot(`
      "Cline
      stdio
      {
        "mcpServers": {
          "toolguard": {
            "command": "node",
            "args": [
              "<TOOLPLANE_REPO>/packages/mcp-adapter/dist/server.js"
            ],
            "env": {
              "TOOLGUARD_PROFILE": "<TOOLGUARD_PROFILE>",
              "TOOLGUARD_CORE_URL": "http://127.0.0.1:3660"
            },
            "disabled": false,
            "autoApprove": []
          }
        }
      }
      Configure Cline only through its MCP settings JSON or remote MCP server UI. This snippet registers ToolGuard as the upstream MCP server.
      Native host tools are not intercepted. Cline tools are protected only when the host routes the call through ToolGuard via MCP, SDK wrappers, or the CLI shim.
      The snippet points to ToolGuard, not direct downstream fixtures. Downstream targets must be configured inside ToolGuard policy.
      ---
      Roo Code
      stdio
      {
        "mcpServers": {
          "toolguard": {
            "command": "node",
            "args": [
              "<TOOLPLANE_REPO>/packages/mcp-adapter/dist/server.js"
            ],
            "env": {
              "TOOLGUARD_PROFILE": "<TOOLGUARD_PROFILE>",
              "TOOLGUARD_CORE_URL": "http://127.0.0.1:3660"
            },
            "disabled": false,
            "alwaysAllow": []
          }
        }
      }
      Configure Roo Code through its MCP settings. This snippet registers ToolGuard as the upstream MCP server.
      Native host tools are not intercepted. Roo Code tools are protected only when the host routes the call through ToolGuard via MCP, SDK wrappers, or the CLI shim.
      The snippet points to ToolGuard, not direct downstream fixtures. Downstream targets must be configured inside ToolGuard policy.
      ---
      Claude Desktop
      stdio
      {
        "mcpServers": {
          "toolguard": {
            "command": "node",
            "args": [
              "<TOOLPLANE_REPO>/packages/mcp-adapter/dist/server.js"
            ],
            "env": {
              "TOOLGUARD_PROFILE": "<TOOLGUARD_PROFILE>",
              "TOOLGUARD_CORE_URL": "http://127.0.0.1:3660"
            }
          }
        }
      }
      Configure Claude Desktop through claude_desktop_config.json using the local MCP server boundary. This snippet registers ToolGuard as the upstream MCP server.
      Native host tools are not intercepted. Claude Desktop tools are protected only when the host routes the call through ToolGuard via MCP, SDK wrappers, or the CLI shim.
      The snippet points to ToolGuard, not direct downstream fixtures. Downstream targets must be configured inside ToolGuard policy.
      ---
      Claude Code
      stdio
      {
        "mcpServers": {
          "toolguard": {
            "command": "node",
            "args": [
              "<TOOLPLANE_REPO>/packages/mcp-adapter/dist/server.js"
            ],
            "env": {
              "TOOLGUARD_PROFILE": "<TOOLGUARD_PROFILE>",
              "TOOLGUARD_CORE_URL": "http://127.0.0.1:3660"
            }
          }
        }
      }
      Configure Claude Code through its MCP server configuration boundary. This snippet registers ToolGuard as the upstream MCP server.
      Native host tools are not intercepted. Claude Code tools are protected only when the host routes the call through ToolGuard via MCP, SDK wrappers, or the CLI shim.
      The snippet points to ToolGuard, not direct downstream fixtures. Downstream targets must be configured inside ToolGuard policy.
      ---
      Cursor
      stdio
      {
        "mcpServers": {
          "toolguard": {
            "command": "node",
            "args": [
              "<TOOLPLANE_REPO>/packages/mcp-adapter/dist/server.js"
            ],
            "env": {
              "TOOLGUARD_PROFILE": "<TOOLGUARD_PROFILE>",
              "TOOLGUARD_CORE_URL": "http://127.0.0.1:3660"
            }
          }
        }
      }
      Configure Cursor through .cursor/mcp.json or the Cursor MCP settings UI. This snippet registers ToolGuard as the upstream MCP server.
      Native host tools are not intercepted. Cursor tools are protected only when the host routes the call through ToolGuard via MCP, SDK wrappers, or the CLI shim.
      The snippet points to ToolGuard, not direct downstream fixtures. Downstream targets must be configured inside ToolGuard policy.
      ---
      Windsurf
      stdio
      {
        "mcpServers": {
          "toolguard": {
            "command": "node",
            "args": [
              "<TOOLPLANE_REPO>/packages/mcp-adapter/dist/server.js"
            ],
            "env": {
              "TOOLGUARD_PROFILE": "<TOOLGUARD_PROFILE>",
              "TOOLGUARD_CORE_URL": "http://127.0.0.1:3660"
            }
          }
        }
      }
      Configure Windsurf Cascade through its MCP configuration. This snippet registers ToolGuard as the upstream MCP server.
      Native host tools are not intercepted. Windsurf tools are protected only when the host routes the call through ToolGuard via MCP, SDK wrappers, or the CLI shim.
      The snippet points to ToolGuard, not direct downstream fixtures. Downstream targets must be configured inside ToolGuard policy.
      ---
      Hermes
      stdio
      {
        "mcpServers": {
          "toolguard": {
            "command": "node",
            "args": [
              "<TOOLPLANE_REPO>/packages/mcp-adapter/dist/server.js"
            ],
            "env": {
              "TOOLGUARD_PROFILE": "<TOOLGUARD_PROFILE>",
              "TOOLGUARD_CORE_URL": "http://127.0.0.1:3660"
            },
            "toolFilter": [
              "tg__*"
            ]
          }
        }
      }
      Configure Hermes through its MCP client configuration and tool filtering. This snippet registers ToolGuard as the upstream MCP server.
      Native host tools are not intercepted. Hermes tools are protected only when the host routes the call through ToolGuard via MCP, SDK wrappers, or the CLI shim.
      The snippet points to ToolGuard, not direct downstream fixtures. Downstream targets must be configured inside ToolGuard policy."
    `);
  });
});
