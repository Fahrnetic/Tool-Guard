import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ClassifiedToolError,
  CoreSession,
  ToolRegistry,
  createId,
  type FailureCard,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type PreflightProbeResult,
  type RegisteredTool,
  type StableId,
  type ToolCall,
  type ToolResult
} from "@toolplane/core";

export interface DownstreamMcpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
}

export interface DownstreamMcpCallContext {
  readonly serverId: StableId;
  readonly toolName: string;
  readonly args: JsonObject;
  readonly signal: AbortSignal;
}

export interface DownstreamMcpServer {
  readonly serverId: StableId;
  readonly name: string;
  readonly version?: string;
  initialize(): Promise<void>;
  listTools(): Promise<readonly DownstreamMcpToolDefinition[]>;
  callTool(context: DownstreamMcpCallContext): Promise<JsonValue>;
  preflight?(): Promise<PreflightProbeResult>;
  close?(): Promise<void>;
}

export interface VirtualMcpTool extends Tool {
  readonly downstreamServerId: StableId;
  readonly originalToolName: string;
}

export interface ToolGuardMcpRouterOptions {
  readonly session: CoreSession;
  readonly coreRegistry: ToolRegistry;
  readonly downstreamServers: readonly DownstreamMcpServer[];
  readonly adapterId?: StableId;
  readonly harnessId?: StableId;
  readonly deadlineMs?: number;
  readonly allowUnhealthyPreflight?: boolean;
}

export class SdkDownstreamMcpServer implements DownstreamMcpServer {
  readonly serverId: StableId;
  readonly name: string;
  readonly version?: string;
  readonly #createTransport: () => Promise<Transport> | Transport;
  #client: Client | undefined;

  constructor(options: {
    readonly serverId: StableId;
    readonly name: string;
    readonly version?: string;
    readonly createTransport: () => Promise<Transport> | Transport;
  }) {
    this.serverId = options.serverId;
    this.name = options.name;
    if (options.version) {
      this.version = options.version;
    }
    this.#createTransport = options.createTransport;
  }

  async initialize(): Promise<void> {
    const client = new Client({ name: "ToolGuard downstream MCP client", version: "0.2.0" });
    await client.connect(await this.#createTransport());
    this.#client = client;
  }

  async listTools(): Promise<readonly DownstreamMcpToolDefinition[]> {
    const client = this.#requireClient();
    const result = await client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema as JsonSchema
    }));
  }

  async callTool(context: DownstreamMcpCallContext): Promise<JsonValue> {
    const client = this.#requireClient();
    const result = await client.callTool(
      { name: context.toolName, arguments: context.args },
      undefined,
      { signal: context.signal }
    );
    return normalizeJsonObject(result.structuredContent ?? result);
  }

  async preflight(): Promise<PreflightProbeResult> {
    try {
      await this.listTools();
      return { status: "healthy", summary: `${this.serverId} initialized and listed tools.` };
    } catch (error) {
      return {
        status: "failed",
        summary: "Downstream MCP client preflight failed.",
        remediation: error instanceof Error ? error.message : "Inspect downstream MCP transport."
      };
    }
  }

  async close(): Promise<void> {
    await this.#client?.close();
    this.#client = undefined;
  }

  #requireClient(): Client {
    if (!this.#client) {
      throw new ClassifiedToolError("process_crash", "Downstream MCP client is not initialized", [
        `downstreamServerId: ${this.serverId}`,
        "Initialize the downstream MCP client before listing or calling tools."
      ]);
    }
    return this.#client;
  }
}

interface Route {
  readonly virtualName: string;
  readonly downstreamServer: DownstreamMcpServer;
  readonly downstreamTool: DownstreamMcpToolDefinition;
  preflight?: PreflightProbeResult;
}

export class ToolGuardMcpRouter {
  readonly #session: CoreSession;
  readonly #registry: ToolRegistry;
  readonly #routes = new Map<string, Route>();
  readonly #adapterId: StableId;
  readonly #harnessId: StableId;
  readonly #deadlineMs: number;
  readonly #allowUnhealthyPreflight: boolean;
  readonly #downstreamServers: readonly DownstreamMcpServer[];
  #closed = false;

  private constructor(options: ToolGuardMcpRouterOptions) {
    this.#session = options.session;
    this.#registry = options.coreRegistry;
    this.#adapterId = options.adapterId ?? "adapter_mcp_toolguard";
    this.#harnessId = options.harnessId ?? "harness_mcp_upstream";
    this.#deadlineMs = options.deadlineMs ?? 1_000;
    this.#allowUnhealthyPreflight = options.allowUnhealthyPreflight ?? false;
    this.#downstreamServers = options.downstreamServers;
  }

  static async create(options: ToolGuardMcpRouterOptions): Promise<ToolGuardMcpRouter> {
    const router = new ToolGuardMcpRouter(options);
    await router.#initialize();
    return router;
  }

  get session(): CoreSession {
    return this.#session;
  }

  listVirtualTools(): readonly VirtualMcpTool[] {
    return [...this.#routes.values()]
      .sort((a, b) => a.virtualName.localeCompare(b.virtualName))
      .map((route) => ({
        name: route.virtualName,
        description: `ToolGuard proxy for ${route.downstreamServer.serverId}:${route.downstreamTool.name}. ${
          route.downstreamTool.description ?? ""
        }`.trim(),
        inputSchema: normalizeMcpInputSchema(route.downstreamTool.inputSchema),
        downstreamServerId: route.downstreamServer.serverId,
        originalToolName: route.downstreamTool.name,
        annotations: {
          title: route.downstreamTool.name,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      }));
  }

  async preflight(): Promise<readonly PreflightProbeResult[]> {
    const findings: PreflightProbeResult[] = [];
    const context = {
      runId: this.#session.runId,
      traceId: createId("trace"),
      harnessId: this.#harnessId,
      adapterId: this.#adapterId
    };
    await this.#session.emitAdapterConnected(context, "MCP adapter connected");
    await this.#session.preflight(this.#registry, context);

    for (const route of this.#routes.values()) {
      const finding = await this.#probeRoute(route);
      route.preflight = finding;
      findings.push(finding);
    }

    return findings;
  }

  async callVirtualTool(
    virtualName: string,
    args: JsonObject = {},
    options: { readonly deadlineMs?: number; readonly parentId?: StableId } = {}
  ): Promise<CallToolResult> {
    const route = this.#routes.get(virtualName);
    if (!route) {
      const call = this.#makeCall({
        virtualName,
        originalToolName: virtualName,
        downstreamServerId: "server_unknown",
        args,
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
        ...(options.parentId === undefined ? {} : { parentId: options.parentId })
      });
      const result = await this.#session.executeToolCall(this.#registry, call);
      return toMcpToolResult(result);
    }

    if (!this.#allowUnhealthyPreflight) {
      const finding = route.preflight ?? (await this.#probeRoute(route));
      route.preflight = finding;
      if (finding.status !== "healthy") {
        const blockedToolName = this.#ensurePreflightBlockedTool(route, finding);
        const call = this.#makeCall({
          virtualName: blockedToolName,
          originalToolName: route.downstreamTool.name,
          downstreamServerId: route.downstreamServer.serverId,
          args,
          ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
          ...(options.parentId === undefined ? {} : { parentId: options.parentId })
        });
        return toMcpToolResult(await this.#session.executeToolCall(this.#registry, call));
      }
    }

    const call = this.#makeCall({
      virtualName,
      originalToolName: route.downstreamTool.name,
      downstreamServerId: route.downstreamServer.serverId,
      args,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.parentId === undefined ? {} : { parentId: options.parentId })
    });
    return toMcpToolResult(await this.#session.executeToolCall(this.#registry, call));
  }

  createUpstreamMcpServer(): McpServer {
    const server = new McpServer({ name: "ToolGuard MCP Proxy", version: "0.2.0" });
    for (const tool of this.listVirtualTools()) {
      server.registerTool(
        tool.name,
        {
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.annotations === undefined ? {} : { annotations: tool.annotations })
        },
        async (args) => this.callVirtualTool(tool.name, normalizeJsonObject(args))
      );
    }
    return server;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.all(this.#downstreamServers.map(async (server) => server.close?.()));
  }

  async #initialize(): Promise<void> {
    for (const downstreamServer of this.#downstreamServers) {
      await downstreamServer.initialize();
      const tools = await downstreamServer.listTools();
      for (const tool of tools) {
        const virtualName = toVirtualToolName(downstreamServer.serverId, tool.name);
        const route: Route = {
          virtualName,
          downstreamServer,
          downstreamTool: tool
        };
        this.#routes.set(virtualName, route);
        this.#registry.register(this.#toRegisteredTool(route));
      }
    }
  }

  #toRegisteredTool(route: Route): RegisteredTool {
    return {
      toolName: route.virtualName,
      title: `ToolGuard ${route.downstreamTool.name}`,
      description: route.downstreamTool.description ?? `Downstream MCP tool ${route.downstreamTool.name}`,
      protocol: "mcp",
      downstreamServerId: route.downstreamServer.serverId,
      inputSchema: route.downstreamTool.inputSchema,
      destructiveRisk: "none",
      preflight: async () => route.preflight ?? (await this.#probeRoute(route)),
      execute: async ({ call, signal }) =>
        route.downstreamServer.callTool({
          serverId: route.downstreamServer.serverId,
          toolName: route.downstreamTool.name,
          args: call.arguments,
          signal
        })
    };
  }

  #ensurePreflightBlockedTool(route: Route, finding: PreflightProbeResult): string {
    const toolName = `${route.virtualName}__preflight_blocked`;
    if (this.#registry.get(toolName)) {
      return toolName;
    }
    this.#registry.register({
      toolName,
      title: `Blocked ${route.downstreamTool.name}`,
      description: "Fail-fast wrapper for unhealthy downstream MCP preflight.",
      protocol: "mcp",
      downstreamServerId: route.downstreamServer.serverId,
      inputSchema: route.downstreamTool.inputSchema,
      destructiveRisk: "none",
      preflight: () => finding,
      execute: () => {
        throw new ClassifiedToolError("policy_blocked", "Unhealthy downstream MCP preflight", [
          `downstreamServerId: ${route.downstreamServer.serverId}`,
          `toolName: ${route.downstreamTool.name}`,
          `preflightStatus: ${finding.status}`,
          `summary: ${finding.summary}`,
          `remediation: ${finding.remediation ?? "Run preflight and repair the downstream MCP server before retrying."}`
        ]);
      }
    });
    return toolName;
  }

  async #probeRoute(route: Route): Promise<PreflightProbeResult> {
    try {
      return route.downstreamServer.preflight
        ? await route.downstreamServer.preflight()
        : { status: "healthy", summary: `${route.downstreamServer.serverId} initialized and listed tools.` };
    } catch (error) {
      return {
        status: "failed",
        summary: "Downstream MCP preflight failed.",
        remediation: error instanceof Error ? error.message : "Inspect downstream MCP process and transport."
      };
    }
  }

  #makeCall(input: {
    readonly virtualName: string;
    readonly originalToolName: string;
    readonly downstreamServerId: StableId;
    readonly args: JsonObject;
    readonly deadlineMs?: number;
    readonly parentId?: StableId;
  }): ToolCall {
    return {
      runId: this.#session.runId,
      traceId: createId("trace"),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      harnessId: this.#harnessId,
      adapterId: this.#adapterId,
      downstreamServerId: input.downstreamServerId,
      toolCallId: createId("toolcall"),
      attemptId: createId("attempt"),
      policyDecisionId: createId("policy"),
      toolName: input.virtualName,
      originalToolName: input.originalToolName,
      arguments: input.args,
      deadlineMs: input.deadlineMs ?? this.#deadlineMs,
      idempotency: "idempotent",
      sourcePath: "mcp-adapter"
    };
  }
}

export function toVirtualToolName(serverId: StableId, toolName: string): string {
  return `tg__${sanitizeName(serverId)}__${sanitizeName(toolName)}`;
}

export function toMcpToolResult(result: ToolResult | FailureCard): CallToolResult {
  if ("failureType" in result) {
    return createMcpToolResultFailureCard(result);
  }
  return {
    content: [
      {
        type: "text",
        text: result.safeSummary
      }
    ],
    structuredContent: normalizeJsonObject(result.output),
    isError: false
  };
}

export function createMcpToolResultFailureCard(value: unknown): CallToolResult {
  const failureCard = normalizeJsonObject(value);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(failureCard, null, 2)
      }
    ],
    structuredContent: failureCard,
    isError: true
  };
}

export function createInMemoryDownstreamServer(options: {
  readonly serverId: StableId;
  readonly name: string;
  readonly version?: string;
  readonly tools: readonly DownstreamMcpToolDefinition[];
  readonly preflightStatus?: PreflightProbeResult["status"];
  readonly handler: (context: DownstreamMcpCallContext) => Promise<JsonValue> | JsonValue;
  readonly close?: () => Promise<void>;
}): DownstreamMcpServer {
  return {
    serverId: options.serverId,
    name: options.name,
    ...(options.version ? { version: options.version } : {}),
    initialize: async () => undefined,
    listTools: async () => options.tools,
    callTool: async (context) => options.handler(context),
    preflight: async () => ({
      status: options.preflightStatus ?? "healthy",
      summary:
        options.preflightStatus && options.preflightStatus !== "healthy"
          ? `${options.serverId} is intentionally ${options.preflightStatus}.`
          : `${options.serverId} is reachable and initialized.`,
      ...(options.preflightStatus && options.preflightStatus !== "healthy"
        ? {
            remediation: "Repair downstream MCP server before routing calls."
          }
        : {})
    }),
    ...(options.close ? { close: options.close } : {})
  };
}

function sanitizeName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : "unnamed";
}

function normalizeMcpInputSchema(schema: JsonSchema): Tool["inputSchema"] {
  return {
    type: "object",
    ...(schema.properties ? { properties: schema.properties as Record<string, object> } : {}),
    ...(schema.required ? { required: [...schema.required] } : {}),
    ...(schema.additionalProperties === undefined ? {} : { additionalProperties: schema.additionalProperties })
  };
}

function normalizeJsonObject(value: unknown): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return { value: value as JsonValue };
}
