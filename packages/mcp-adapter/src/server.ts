import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CoreSession, ToolRegistry, createId, type StableId } from "@toolplane/core";
import { SdkDownstreamMcpServer, ToolGuardMcpRouter, type DownstreamMcpServer } from "./index.js";

export interface ToolGuardMcpStdioServerOptions {
  readonly evidenceRoot?: string;
  readonly downstreamServers?: readonly DownstreamMcpServer[];
  readonly env?: NodeJS.ProcessEnv;
}

export async function startToolGuardMcpStdioServer(options: ToolGuardMcpStdioServerOptions = {}): Promise<ToolGuardMcpRouter> {
  const profile = options.downstreamServers
    ? { downstreamServers: options.downstreamServers }
    : await loadToolGuardProfileFromEnvironment(options.env ?? process.env);
  const downstreamServers = profile.downstreamServers;
  if (downstreamServers.length === 0) {
    throw new Error(
      "ToolGuard MCP stdio server has no downstream servers configured. Set TOOLGUARD_PROFILE to a local JSON profile containing downstreamServers, or pass downstreamServers explicitly."
    );
  }
  const session = new CoreSession({
    evidenceRoot: options.evidenceRoot ?? profile?.evidenceRoot ?? path.join(process.cwd(), "runs"),
    runId: createId("run")
  });
  const router = await ToolGuardMcpRouter.create({
    session,
    coreRegistry: new ToolRegistry(),
    downstreamServers
  });
  await router.createUpstreamMcpServer().connect(new StdioServerTransport());
  return router;
}

export interface ToolGuardProfile {
  readonly evidenceRoot?: string;
  readonly downstreamServers: readonly DownstreamMcpServer[];
}

interface ToolGuardProfileFile {
  readonly evidenceRoot?: unknown;
  readonly downstreamServers?: unknown;
}

interface StdioDownstreamProfile {
  readonly serverId?: unknown;
  readonly name?: unknown;
  readonly version?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: unknown;
  readonly cwd?: unknown;
}

export async function loadToolGuardProfileFromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<ToolGuardProfile> {
  validateCoreUrl(env.TOOLGUARD_CORE_URL);
  const profilePath = env.TOOLGUARD_PROFILE;
  if (!profilePath) {
    throw new Error(
      "TOOLGUARD_PROFILE is required for the generated ToolGuard MCP stdio server entrypoint. Point it to a local JSON profile with downstreamServers."
    );
  }
  if (profilePath.includes("<") || profilePath.includes(">")) {
    throw new Error("TOOLGUARD_PROFILE still contains a placeholder. Replace it with a local ToolGuard profile JSON path.");
  }

  const profile = JSON.parse(await readFile(profilePath, "utf8")) as ToolGuardProfileFile;
  const downstreamProfiles = Array.isArray(profile.downstreamServers) ? profile.downstreamServers : [];
  const downstreamServers = downstreamProfiles.map((entry, index) => toDownstreamServer(entry as StdioDownstreamProfile, index));
  return {
    ...(typeof profile.evidenceRoot === "string" ? { evidenceRoot: profile.evidenceRoot } : {}),
    downstreamServers
  };
}

function toDownstreamServer(profile: StdioDownstreamProfile, index: number): DownstreamMcpServer {
  if (typeof profile.serverId !== "string" || typeof profile.name !== "string" || typeof profile.command !== "string") {
    throw new Error(`Invalid downstreamServers[${index}] in TOOLGUARD_PROFILE: serverId, name, and command are required strings.`);
  }
  const params: StdioServerParameters = {
    command: profile.command,
    args: Array.isArray(profile.args) ? profile.args.map(String) : [],
    stderr: "pipe"
  };
  if (isStringRecord(profile.env)) {
    params.env = profile.env;
  }
  if (typeof profile.cwd === "string") {
    params.cwd = profile.cwd;
  }
  return new SdkDownstreamMcpServer({
    serverId: profile.serverId as StableId,
    name: profile.name,
    ...(typeof profile.version === "string" ? { version: profile.version } : {}),
    createTransport: () => new StdioClientTransport(params)
  });
}

function validateCoreUrl(coreUrl: string | undefined): void {
  if (!coreUrl) {
    return;
  }
  const parsed = new URL(coreUrl);
  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (!["http:", "https:"].includes(parsed.protocol) || !localHosts.has(parsed.hostname)) {
    throw new Error("TOOLGUARD_CORE_URL must be a local loopback HTTP(S) URL, for example http://127.0.0.1:3660.");
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startToolGuardMcpStdioServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
