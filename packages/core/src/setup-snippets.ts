import { PRODUCT_DISPLAY_NAME } from "./product.js";

export type SetupSnippetPlatform = "posix" | "powershell" | "cmd" | "wsl" | "container" | "ci";
export type SetupSnippetRoute = "mcp-routed" | "cli-supervised" | "sdk-wrapped-python" | "shell-api";
export type SetupSnippetLanguage = "shell" | "powershell" | "cmd" | "json" | "yaml" | "python" | "dockerfile";

export type SupportedMcpHostId =
  "cline" | "roo-code" | "claude-desktop" | "claude-code" | "cursor" | "windsurf" | "codex-cli" | "opencode" | "hermes";

export interface SetupSnippetOptions {
  readonly repoPlaceholder?: string;
  readonly coreUrl?: string;
  readonly profilePlaceholder?: string;
  readonly evidenceRootPlaceholder?: string;
  readonly containerImage?: string;
}

export interface PlatformCommandSnippet {
  readonly id: string;
  readonly route: SetupSnippetRoute;
  readonly platform: SetupSnippetPlatform;
  readonly title: string;
  readonly language: SetupSnippetLanguage;
  readonly command: string;
  readonly limitations: readonly string[];
}

export interface HostConfigSnippet {
  readonly hostId: SupportedMcpHostId;
  readonly hostName: string;
  readonly hostFamily: "claude-style" | "cursor-windsurf-style" | "cline-roo-style" | "codex-opencode-style" | "hermes-style";
  readonly claimLevel: "MCP-routed only";
  readonly transport: "stdio";
  readonly boundary: string;
  readonly configJson: string;
  readonly setupCommand: PlatformCommandSnippet;
  readonly limitations: readonly string[];
}

export interface VisibilitySetupSnippets {
  readonly generatedBy: "toolguard-shared-setup-snippets";
  readonly platforms: readonly PlatformCommandSnippet[];
  readonly mcpHosts: readonly HostConfigSnippet[];
}

interface HostBoundary {
  readonly hostId: SupportedMcpHostId;
  readonly hostName: string;
  readonly hostFamily: HostConfigSnippet["hostFamily"];
  readonly boundary: string;
  readonly extraServerFields?: Readonly<Record<string, unknown>>;
}

const DEFAULT_CORE_URL = "http://127.0.0.1:3660";
const DEFAULT_REPO_PLACEHOLDER = "<TOOLPLANE_REPO>";
const DEFAULT_PROFILE_PLACEHOLDER = "<TOOLGUARD_PROFILE_JSON>";
const DEFAULT_EVIDENCE_ROOT_PLACEHOLDER = "<TOOLGUARD_EVIDENCE_DIR>";

const ROUTE_LIMITATIONS: Readonly<Record<SetupSnippetRoute, readonly string[]>> = {
  "mcp-routed": [
    `${PRODUCT_DISPLAY_NAME} protects MCP calls only when the host routes them through the ${PRODUCT_DISPLAY_NAME} MCP stdio server.`,
    "Native host tools and direct IDE actions are not intercepted by this route.",
    "Downstream MCP servers must be declared in the local profile file referenced by TOOLGUARD_PROFILE."
  ],
  "cli-supervised": [
    `${PRODUCT_DISPLAY_NAME} supervises the spawned process boundary only.`,
    "Native agent tool calls are not covered unless they are invoked through this wrapper, MCP, SDK wrappers, or the ToolGuard API."
  ],
  "sdk-wrapped-python": [
    `${PRODUCT_DISPLAY_NAME} observes Python framework tools only when code explicitly uses the ToolGuard adapter wrappers.`,
    "Direct LangGraph, CrewAI, or Python function calls are not intercepted automatically."
  ],
  "shell-api": [
    `${PRODUCT_DISPLAY_NAME} receives events through the local loopback Core/API only.`,
    "Shell snippets do not imply native host interception or coverage for tools that bypass the routed boundary."
  ]
};

const HOST_BOUNDARIES: readonly HostBoundary[] = [
  {
    hostId: "cline",
    hostName: "Cline",
    hostFamily: "cline-roo-style",
    boundary: "Configure Cline through its MCP settings JSON or remote MCP server UI.",
    extraServerFields: { disabled: false, autoApprove: [] }
  },
  {
    hostId: "roo-code",
    hostName: "Roo Code",
    hostFamily: "cline-roo-style",
    boundary: "Configure Roo Code through its MCP settings.",
    extraServerFields: { disabled: false, alwaysAllow: [] }
  },
  {
    hostId: "claude-desktop",
    hostName: "Claude Desktop",
    hostFamily: "claude-style",
    boundary: "Configure Claude Desktop through claude_desktop_config.json using the local MCP server boundary."
  },
  {
    hostId: "claude-code",
    hostName: "Claude Code",
    hostFamily: "claude-style",
    boundary: "Configure Claude Code through its MCP server configuration boundary."
  },
  {
    hostId: "cursor",
    hostName: "Cursor",
    hostFamily: "cursor-windsurf-style",
    boundary: "Configure Cursor through .cursor/mcp.json or the Cursor MCP settings UI."
  },
  {
    hostId: "windsurf",
    hostName: "Windsurf",
    hostFamily: "cursor-windsurf-style",
    boundary: "Configure Windsurf Cascade through its MCP configuration."
  },
  {
    hostId: "codex-cli",
    hostName: "Codex CLI",
    hostFamily: "codex-opencode-style",
    boundary: "Configure Codex CLI only where an MCP server configuration boundary is available for the local session."
  },
  {
    hostId: "opencode",
    hostName: "OpenCode",
    hostFamily: "codex-opencode-style",
    boundary: "Configure OpenCode only through its documented MCP server configuration boundary."
  },
  {
    hostId: "hermes",
    hostName: "Hermes",
    hostFamily: "hermes-style",
    boundary: "Configure Hermes through its MCP client configuration and tool filtering.",
    extraServerFields: { toolFilter: ["tg__*"] }
  }
];

export function generateVisibilitySetupSnippets(options: SetupSnippetOptions = {}): VisibilitySetupSnippets {
  const platforms = generatePlatformCommandSnippets(options);
  return {
    generatedBy: "toolguard-shared-setup-snippets",
    platforms,
    mcpHosts: generateHostConfigSnippets(options, platforms)
  };
}

export function generatePlatformCommandSnippets(options: SetupSnippetOptions = {}): readonly PlatformCommandSnippet[] {
  const repo = options.repoPlaceholder ?? DEFAULT_REPO_PLACEHOLDER;
  const coreUrl = options.coreUrl ?? DEFAULT_CORE_URL;
  const profile = options.profilePlaceholder ?? DEFAULT_PROFILE_PLACEHOLDER;
  const evidenceRoot = options.evidenceRootPlaceholder ?? DEFAULT_EVIDENCE_ROOT_PLACEHOLDER;
  const image = options.containerImage ?? "ghcr.io/toolplane/toolguard:local";
  const mcpServerPath = `${repo}/packages/mcp-adapter/dist/server.js`;
  return [
    snippet(
      "mcp-posix",
      "mcp-routed",
      "posix",
      "MCP stdio server, POSIX shell",
      "shell",
      [
        `TOOLGUARD_CORE_URL=${shellQuote(coreUrl)} \\`,
        `TOOLGUARD_PROFILE=${shellQuote(profile)} \\`,
        `node ${shellQuote(mcpServerPath)}`
      ].join("\n"),
      ROUTE_LIMITATIONS["mcp-routed"]
    ),
    snippet(
      "mcp-powershell",
      "mcp-routed",
      "powershell",
      "MCP stdio server, PowerShell",
      "powershell",
      [
        `$env:TOOLGUARD_CORE_URL = ${powerShellQuote(coreUrl)}`,
        `$env:TOOLGUARD_PROFILE = ${powerShellQuote(profile)}`,
        `node ${powerShellQuote(mcpServerPath)}`
      ].join("\n"),
      ROUTE_LIMITATIONS["mcp-routed"]
    ),
    snippet(
      "mcp-cmd",
      "mcp-routed",
      "cmd",
      "MCP stdio server, CMD",
      "cmd",
      [`set "TOOLGUARD_CORE_URL=${coreUrl}"`, `set "TOOLGUARD_PROFILE=${profile}"`, `node "${mcpServerPath}"`].join("\r\n"),
      ROUTE_LIMITATIONS["mcp-routed"]
    ),
    snippet(
      "mcp-wsl",
      "mcp-routed",
      "wsl",
      "MCP stdio server, WSL",
      "shell",
      [
        `wsl --cd ${shellQuote(repo)} -- bash -lc ${shellQuote(
          `TOOLGUARD_CORE_URL=${coreUrl} TOOLGUARD_PROFILE=${profile} node packages/mcp-adapter/dist/server.js`
        )}`
      ].join("\n"),
      ROUTE_LIMITATIONS["mcp-routed"]
    ),
    snippet(
      "mcp-container",
      "mcp-routed",
      "container",
      "MCP stdio server, container",
      "shell",
      [
        `docker run --rm -i \\`,
        `  --network host \\`,
        `  -e TOOLGUARD_CORE_URL=${shellQuote(coreUrl)} \\`,
        `  -e TOOLGUARD_PROFILE=/workspace/toolguard-profile.json \\`,
        `  -v ${shellQuote(`${repo}:/workspace:ro`)} \\`,
        `  ${shellQuote(image)} node /workspace/packages/mcp-adapter/dist/server.js`
      ].join("\n"),
      ROUTE_LIMITATIONS["mcp-routed"]
    ),
    snippet(
      "ci-github-actions",
      "cli-supervised",
      "ci",
      "CLI supervised smoke test, GitHub Actions",
      "yaml",
      [
        "steps:",
        "  - uses: actions/checkout@v4",
        "  - uses: pnpm/action-setup@v4",
        "    with:",
        "      version: 10.25.0",
        "  - uses: actions/setup-node@v4",
        "    with:",
        "      node-version: 22",
        "      cache: pnpm",
        "  - run: pnpm install --frozen-lockfile",
        "  - run: pnpm --filter @toolplane/cli build",
        `  - run: node packages/cli/dist/bin/toolplane.js run --evidence-root ${evidenceRoot} -- npm --version`
      ].join("\n"),
      ROUTE_LIMITATIONS["cli-supervised"]
    ),
    snippet(
      "cli-posix",
      "cli-supervised",
      "posix",
      "CLI supervised command, POSIX shell",
      "shell",
      [
        `toolguard run --evidence-root ${shellQuote(evidenceRoot)} -- <safe-command>`,
        "# Process-level supervision only. Route host tools through MCP or SDK wrappers for tool-call visibility."
      ].join("\n"),
      ROUTE_LIMITATIONS["cli-supervised"]
    ),
    snippet(
      "cli-powershell",
      "cli-supervised",
      "powershell",
      "CLI supervised command, PowerShell",
      "powershell",
      [
        `toolguard run --evidence-root ${powerShellQuote(evidenceRoot)} -- <safe-command>`,
        "# Process-level supervision only. Route host tools through MCP or SDK wrappers for tool-call visibility."
      ].join("\n"),
      ROUTE_LIMITATIONS["cli-supervised"]
    ),
    snippet(
      "cli-cmd",
      "cli-supervised",
      "cmd",
      "CLI supervised command, CMD",
      "cmd",
      [
        `toolguard run --evidence-root "${evidenceRoot}" -- <safe-command>`,
        "REM Process-level supervision only. Route host tools through MCP or SDK wrappers for tool-call visibility."
      ].join("\r\n"),
      ROUTE_LIMITATIONS["cli-supervised"]
    ),
    snippet(
      "python-wrapper",
      "sdk-wrapped-python",
      "posix",
      "Python SDK wrapper",
      "python",
      [
        "from toolguard_adapters import ToolGuardSidecarClient",
        "",
        `client = ToolGuardSidecarClient(${JSON.stringify(coreUrl)})`,
        "# Wrap framework tools explicitly. Direct framework tools are not intercepted."
      ].join("\n"),
      ROUTE_LIMITATIONS["sdk-wrapped-python"]
    ),
    snippet(
      "shell-core-health",
      "shell-api",
      "posix",
      "Core/API loopback health check",
      "shell",
      [
        `curl -fsS ${shellQuote(`${coreUrl}/health`)}`,
        "# This checks the local Core/API surface only. It is not proof of host-native interception."
      ].join("\n"),
      ROUTE_LIMITATIONS["shell-api"]
    )
  ];
}

export function generateHostConfigSnippets(
  options: SetupSnippetOptions = {},
  platformSnippets: readonly PlatformCommandSnippet[] = generatePlatformCommandSnippets(options)
): readonly HostConfigSnippet[] {
  const coreUrl = options.coreUrl ?? DEFAULT_CORE_URL;
  const profile = options.profilePlaceholder ?? DEFAULT_PROFILE_PLACEHOLDER;
  const repo = options.repoPlaceholder ?? DEFAULT_REPO_PLACEHOLDER;
  const serverModulePath = `${repo}/packages/mcp-adapter/dist/server.js`;
  const setupCommand = requiredSnippet(platformSnippets, "mcp-posix");

  return HOST_BOUNDARIES.map((host) => {
    const config = {
      mcpServers: {
        toolguard: {
          command: "node",
          args: [serverModulePath],
          env: {
            TOOLGUARD_PROFILE: profile,
            TOOLGUARD_CORE_URL: coreUrl
          },
          ...host.extraServerFields
        }
      }
    };
    const limitations = [
      `${host.boundary} This snippet registers ${PRODUCT_DISPLAY_NAME} as the upstream MCP server over stdio transport.`,
      `${host.hostName} is ${host.hostFamily}; this is an MCP-routed-only card, not a native host interception claim.`,
      ...ROUTE_LIMITATIONS["mcp-routed"]
    ];

    return {
      hostId: host.hostId,
      hostName: host.hostName,
      hostFamily: host.hostFamily,
      claimLevel: "MCP-routed only",
      transport: "stdio",
      boundary: host.boundary,
      configJson: JSON.stringify(config, null, 2),
      setupCommand,
      limitations
    };
  });
}

function snippet(
  id: string,
  route: SetupSnippetRoute,
  platform: SetupSnippetPlatform,
  title: string,
  language: SetupSnippetLanguage,
  command: string,
  limitations: readonly string[]
): PlatformCommandSnippet {
  return { id, route, platform, title, language, command, limitations };
}

function requiredSnippet(snippets: readonly PlatformCommandSnippet[], id: string): PlatformCommandSnippet {
  const found = snippets.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing shared setup snippet ${id}`);
  return found;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
