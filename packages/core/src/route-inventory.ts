import type { IntegrationRouteType, VisibilityLevel } from "./types.js";
import type { SetupSnippetPlatform, SetupSnippetRoute, SupportedMcpHostId } from "./setup-snippets.js";

export type CanonicalRouteInventoryId =
  | "direct-core-api"
  | "mcp-routed"
  | "cli-supervised"
  | "sdk-wrapped-python"
  | "js-ts-wrapper"
  | "http-webhook-import"
  | "browser-evidence-import"
  | "visibility-jsonl-import"
  | "otel-evidence-transport"
  | "native-host-tools";

export type RouteInventoryCategory = "proofed-route" | "imported-evidence" | "evidence-transport" | "non-claim";

export interface ReadmeRouteClaimMapping {
  readonly claimId: string;
  readonly readmeText: string;
  readonly inventoryId: CanonicalRouteInventoryId;
}

export interface CanonicalRouteInventoryEntry {
  readonly id: CanonicalRouteInventoryId;
  readonly label: string;
  readonly category: RouteInventoryCategory;
  readonly routeType?: IntegrationRouteType;
  readonly visibilityLevel: VisibilityLevel;
  readonly coverageClaim: VisibilityLevel;
  readonly evidenceScope: "route" | "transport" | "host-config" | "none";
  readonly producesRouteEvidence: boolean;
  readonly routePassportRequired: boolean;
  readonly transports: readonly string[];
  readonly setupSnippetRoutes: readonly SetupSnippetRoute[];
  readonly setupPlatforms: readonly SetupSnippetPlatform[];
  readonly mcpHostIds: readonly SupportedMcpHostId[];
  readonly proofSurfaces: readonly string[];
  readonly limitations: readonly string[];
}

export const README_ROUTE_CLAIM_MAPPINGS: readonly ReadmeRouteClaimMapping[] = [
  {
    claimId: "architecture-direct-call",
    readmeText: "direct call | MCP route | CLI wrapper | Python adapter",
    inventoryId: "direct-core-api"
  },
  {
    claimId: "what-it-does-direct-core",
    readmeText: "direct calls into `@toolplane/core`",
    inventoryId: "direct-core-api"
  },
  {
    claimId: "what-it-does-mcp",
    readmeText: "MCP-routed calls through `@toolplane/mcp-adapter`",
    inventoryId: "mcp-routed"
  },
  {
    claimId: "what-it-does-cli",
    readmeText: "process supervision through the `toolguard` / `toolplane` CLI wrapper",
    inventoryId: "cli-supervised"
  },
  {
    claimId: "what-it-does-python",
    readmeText: "thin Python adapter calls for LangGraph and CrewAI-style flows",
    inventoryId: "sdk-wrapped-python"
  },
  {
    claimId: "compatibility-js-wrapper",
    readmeText: "explicit JS/TS wrappers",
    inventoryId: "js-ts-wrapper"
  },
  {
    claimId: "interop-http-webhook",
    readmeText: "bounded HTTP/webhook imports",
    inventoryId: "http-webhook-import"
  },
  {
    claimId: "interop-browser-evidence",
    readmeText: "browser evidence summaries",
    inventoryId: "browser-evidence-import"
  },
  {
    claimId: "interop-otel",
    readmeText: "local OpenTelemetry-compatible evidence exports",
    inventoryId: "otel-evidence-transport"
  },
  {
    claimId: "interop-visibility-jsonl",
    readmeText: "Visibility JSONL imports",
    inventoryId: "visibility-jsonl-import"
  },
  {
    claimId: "native-bypass-non-claim",
    readmeText: "It does **not** natively intercept arbitrary host tools that bypass ToolGuard.",
    inventoryId: "native-host-tools"
  }
];

export const CANONICAL_ROUTE_INVENTORY: readonly CanonicalRouteInventoryEntry[] = [
  {
    id: "direct-core-api",
    label: "Direct Core/API",
    category: "proofed-route",
    visibilityLevel: "mediated",
    coverageClaim: "mediated",
    evidenceScope: "route",
    producesRouteEvidence: true,
    routePassportRequired: false,
    transports: ["in-process-core", "http-loopback-api"],
    setupSnippetRoutes: ["shell-api"],
    setupPlatforms: ["posix"],
    mcpHostIds: [],
    proofSurfaces: ["CoreSession", "createCoreApiServer", "/api/integrations"],
    limitations: [
      "Direct Core/API evidence covers explicit CoreSession calls and local loopback API surfaces only.",
      "Shell/API setup snippets map to this entry and do not create a separate route category."
    ]
  },
  {
    id: "mcp-routed",
    label: "MCP routed adapter path",
    category: "proofed-route",
    routeType: "mcp-routed",
    visibilityLevel: "mediated",
    coverageClaim: "mediated",
    evidenceScope: "route",
    producesRouteEvidence: true,
    routePassportRequired: true,
    transports: ["stdio"],
    setupSnippetRoutes: ["mcp-routed"],
    setupPlatforms: ["posix", "powershell", "cmd", "wsl", "container"],
    mcpHostIds: ["cline", "roo-code", "claude-desktop", "claude-code", "cursor", "windsurf", "codex-cli", "opencode", "hermes"],
    proofSurfaces: ["verifyIntegrationRoute", "doctor:integrations", "/api/integrations"],
    limitations: ["Covered only when host calls route through the ToolGuard MCP stdio server."]
  },
  {
    id: "cli-supervised",
    label: "CLI supervised process path",
    category: "proofed-route",
    routeType: "cli-supervised",
    visibilityLevel: "supervised",
    coverageClaim: "supervised",
    evidenceScope: "route",
    producesRouteEvidence: true,
    routePassportRequired: true,
    transports: ["process-argv"],
    setupSnippetRoutes: ["cli-supervised"],
    setupPlatforms: ["posix", "powershell", "cmd", "ci"],
    mcpHostIds: [],
    proofSurfaces: ["toolguard run --", "doctor:integrations", "/api/integrations"],
    limitations: ["Process supervision does not intercept native in-agent tool calls."]
  },
  {
    id: "sdk-wrapped-python",
    label: "Python SDK-wrapped sidecar path",
    category: "proofed-route",
    routeType: "sdk-wrapped-python",
    visibilityLevel: "observed",
    coverageClaim: "observed",
    evidenceScope: "route",
    producesRouteEvidence: true,
    routePassportRequired: true,
    transports: ["http-loopback-sidecar"],
    setupSnippetRoutes: ["sdk-wrapped-python"],
    setupPlatforms: ["posix"],
    mcpHostIds: [],
    proofSurfaces: ["LangGraph wrapper", "CrewAI wrapper", "doctor:integrations"],
    limitations: ["Direct framework calls outside explicit ToolGuard wrappers are not intercepted."]
  },
  {
    id: "js-ts-wrapper",
    label: "JS/TS explicit wrapper path",
    category: "proofed-route",
    routeType: "js-ts-wrapper",
    visibilityLevel: "mediated",
    coverageClaim: "mediated",
    evidenceScope: "route",
    producesRouteEvidence: true,
    routePassportRequired: true,
    transports: ["in-process-function"],
    setupSnippetRoutes: [],
    setupPlatforms: [],
    mcpHostIds: [],
    proofSurfaces: ["wrapLocalToolFunction"],
    limitations: ["Only explicit wrapper calls are mediated."]
  },
  {
    id: "http-webhook-import",
    label: "HTTP/webhook evidence import",
    category: "imported-evidence",
    routeType: "http-webhook-import",
    visibilityLevel: "imported",
    coverageClaim: "imported",
    evidenceScope: "route",
    producesRouteEvidence: true,
    routePassportRequired: true,
    transports: ["http-loopback-import"],
    setupSnippetRoutes: [],
    setupPlatforms: [],
    mcpHostIds: [],
    proofSurfaces: ["/api/visibility/import/http"],
    limitations: ["Imported evidence is bounded and redacted after receipt; ToolGuard did not mediate the original action."]
  },
  {
    id: "browser-evidence-import",
    label: "Browser evidence import",
    category: "imported-evidence",
    routeType: "browser-evidence-import",
    visibilityLevel: "observed",
    coverageClaim: "observed",
    evidenceScope: "route",
    producesRouteEvidence: true,
    routePassportRequired: true,
    transports: ["browser-summary-import"],
    setupSnippetRoutes: [],
    setupPlatforms: [],
    mcpHostIds: [],
    proofSurfaces: ["/api/visibility/import/browser"],
    limitations: ["Synthetic browser evidence import does not launch a browser and does not mediate browser-native actions."]
  },
  {
    id: "visibility-jsonl-import",
    label: "Visibility JSONL import",
    category: "evidence-transport",
    visibilityLevel: "imported",
    coverageClaim: "imported",
    evidenceScope: "transport",
    producesRouteEvidence: false,
    routePassportRequired: false,
    transports: ["jsonl"],
    setupSnippetRoutes: [],
    setupPlatforms: [],
    mcpHostIds: [],
    proofSurfaces: ["importVisibilityEventsJsonl"],
    limitations: ["Visibility JSONL import is transport/import evidence and must not be promoted to mediated route coverage."]
  },
  {
    id: "otel-evidence-transport",
    label: "OpenTelemetry evidence transport",
    category: "evidence-transport",
    visibilityLevel: "imported",
    coverageClaim: "imported",
    evidenceScope: "transport",
    producesRouteEvidence: false,
    routePassportRequired: false,
    transports: ["opentelemetry-resource-spans-json"],
    setupSnippetRoutes: [],
    setupPlatforms: [],
    mcpHostIds: [],
    proofSurfaces: ["exportVisibilityOtel"],
    limitations: ["OpenTelemetry is local evidence transport/interop metadata unless another ToolGuard boundary produced the route."]
  },
  {
    id: "native-host-tools",
    label: "Native host tools that bypass ToolGuard",
    category: "non-claim",
    visibilityLevel: "not-covered",
    coverageClaim: "not-covered",
    evidenceScope: "none",
    producesRouteEvidence: false,
    routePassportRequired: false,
    transports: [],
    setupSnippetRoutes: [],
    setupPlatforms: [],
    mcpHostIds: [],
    proofSurfaces: [],
    limitations: [
      "ToolGuard does not natively intercept arbitrary host tools that bypass routed, wrapped, supervised, or imported boundaries."
    ]
  }
];

export function getCanonicalRouteInventoryEntry(id: CanonicalRouteInventoryId): CanonicalRouteInventoryEntry {
  const entry = CANONICAL_ROUTE_INVENTORY.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown canonical route inventory entry: ${id}`);
  return entry;
}
