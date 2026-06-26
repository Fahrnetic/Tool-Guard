import { PRODUCT_DISPLAY_NAME } from "@toolplane/core";

export type SupportedMcpHostId =
  | "cline"
  | "roo-code"
  | "claude-desktop"
  | "claude-code"
  | "cursor"
  | "windsurf"
  | "hermes";

export interface HostConfigSnippetOptions {
  readonly toolplaneRepoPath?: string;
  readonly command?: string;
  readonly serverModulePath?: string;
  readonly coreUrl?: string;
  readonly profilePlaceholder?: string;
}

export interface HostConfigSnippet {
  readonly hostId: SupportedMcpHostId;
  readonly hostName: string;
  readonly claimLevel: "MCP-routed only";
  readonly transport: "stdio";
  readonly boundary: string;
  readonly configJson: string;
  readonly limitations: readonly string[];
}

interface HostBoundary {
  readonly hostId: SupportedMcpHostId;
  readonly hostName: string;
  readonly boundary: string;
  readonly extraServerFields?: Readonly<Record<string, unknown>>;
}

const HOST_BOUNDARIES: readonly HostBoundary[] = [
  {
    hostId: "cline",
    hostName: "Cline",
    boundary: "Configure Cline only through its MCP settings JSON or remote MCP server UI.",
    extraServerFields: { disabled: false, autoApprove: [] }
  },
  {
    hostId: "roo-code",
    hostName: "Roo Code",
    boundary: "Configure Roo Code through its MCP settings.",
    extraServerFields: { disabled: false, alwaysAllow: [] }
  },
  {
    hostId: "claude-desktop",
    hostName: "Claude Desktop",
    boundary: "Configure Claude Desktop through claude_desktop_config.json using the local MCP server boundary."
  },
  {
    hostId: "claude-code",
    hostName: "Claude Code",
    boundary: "Configure Claude Code through its MCP server configuration boundary."
  },
  {
    hostId: "cursor",
    hostName: "Cursor",
    boundary: "Configure Cursor through .cursor/mcp.json or the Cursor MCP settings UI."
  },
  {
    hostId: "windsurf",
    hostName: "Windsurf",
    boundary: "Configure Windsurf Cascade through its MCP configuration."
  },
  {
    hostId: "hermes",
    hostName: "Hermes",
    boundary: "Configure Hermes through its MCP client configuration and tool filtering.",
    extraServerFields: { toolFilter: ["tg__*"] }
  }
];

export function generateHostConfigSnippets(options: HostConfigSnippetOptions = {}): readonly HostConfigSnippet[] {
  const toolplaneRepoPath = options.toolplaneRepoPath ?? "<TOOLPLANE_REPO>";
  const command = options.command ?? "node";
  const serverModulePath = options.serverModulePath ?? `${toolplaneRepoPath}/packages/mcp-adapter/dist/server.js`;
  const coreUrl = options.coreUrl ?? "http://127.0.0.1:3660";
  const profilePlaceholder = options.profilePlaceholder ?? "<TOOLGUARD_PROFILE>";

  return HOST_BOUNDARIES.map((host) => {
    const config = {
      mcpServers: {
        toolguard: {
          command,
          args: [serverModulePath],
          env: {
            TOOLGUARD_PROFILE: profilePlaceholder,
            TOOLGUARD_CORE_URL: coreUrl
          },
          ...host.extraServerFields
        }
      }
    };
    const limitations = [
      `${host.boundary} This snippet registers ${PRODUCT_DISPLAY_NAME} as the upstream MCP server.`,
      `Native host tools are not intercepted. ${host.hostName} tools are protected only when the host routes the call through ${PRODUCT_DISPLAY_NAME} via MCP, SDK wrappers, or the CLI shim.`,
      `The snippet points to ${PRODUCT_DISPLAY_NAME}, not direct downstream fixtures. Downstream targets must be configured inside ${PRODUCT_DISPLAY_NAME} policy.`
    ];

    return {
      hostId: host.hostId,
      hostName: host.hostName,
      claimLevel: "MCP-routed only",
      transport: "stdio",
      boundary: host.boundary,
      configJson: JSON.stringify(config, null, 2),
      limitations
    };
  });
}
