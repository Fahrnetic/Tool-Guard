import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  generateHostConfigSnippets,
  generatePlatformCommandSnippets,
  generateVisibilitySetupSnippets,
  type SetupSnippetPlatform
} from "../src/index.js";

const SECRET_OR_LOCAL_PATH_PATTERN =
  /(Bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9]{20,}|BEGIN (?:RSA |OPENSSH |EC |)?PRIVATE KEY|AKIA[0-9A-Z]{16}|\/home\/|\/Users\/|[A-Z]:\\Users\\)/;

describe("shared visibility setup snippets", () => {
  it("generates all required platform variants without secrets or developer-machine absolute paths", () => {
    const generated = generateVisibilitySetupSnippets();
    const platforms = new Set(generated.platforms.map((snippet) => snippet.platform));
    const required: readonly SetupSnippetPlatform[] = ["posix", "powershell", "cmd", "wsl", "container", "ci"];

    expect(generated.generatedBy).toBe("toolguard-shared-setup-snippets");
    for (const platform of required) {
      expect(platforms.has(platform)).toBe(true);
    }

    const serialized = JSON.stringify(generated, null, 2);
    expect(serialized).not.toMatch(SECRET_OR_LOCAL_PATH_PATTERN);
    expect(serialized).not.toMatch(/pnpm.*@toolplane\/mcp-adapter.*start/);
    expect(serialized).not.toContain("direct downstream fixtures");
    expect(serialized).toContain("Native host tools and direct IDE actions are not intercepted");
  });

  it("matches current package entrypoints for MCP, CLI, and Python setup", async () => {
    const repoRoot = path.resolve("../..");
    const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    const cliPackage = JSON.parse(await readFile(path.join(repoRoot, "packages/cli/package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    const mcpPackage = JSON.parse(await readFile(path.join(repoRoot, "packages/mcp-adapter/package.json"), "utf8")) as {
      main?: string;
    };

    const snippets = generatePlatformCommandSnippets();
    const commands = snippets.map((snippet) => snippet.command).join("\n");

    expect(rootPackage.packageManager).toBe("pnpm@10.25.0");
    expect(cliPackage.bin?.toolguard).toBe("./dist/bin/toolplane.js");
    expect(mcpPackage.main).toBe("./dist/index.js");
    expect(commands).toContain("packages/mcp-adapter/dist/server.js");
    expect(commands).toContain("toolguard run --evidence-root");
    expect(commands).toContain("node packages/cli/dist/bin/toolplane.js run");
    expect(commands).toContain("from toolguard_adapters import ToolGuardSidecarClient");
    expect(commands).not.toContain("from toolplane import ToolGuardSidecarClient");
  });

  it("includes current MCP host cards with transport labels, families, and limitations", () => {
    const hosts = generateHostConfigSnippets();
    expect(hosts.map((host) => host.hostId)).toEqual([
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
    expect(new Set(hosts.map((host) => host.hostFamily))).toEqual(
      new Set(["cline-roo-style", "claude-style", "cursor-windsurf-style", "codex-opencode-style", "hermes-style"])
    );
    for (const host of hosts) {
      const config = JSON.parse(host.configJson) as {
        mcpServers?: { toolguard?: { command?: string; args?: string[]; env?: Record<string, string> } };
      };
      expect(host.transport).toBe("stdio");
      expect(host.claimLevel).toBe("MCP-routed only");
      expect(config.mcpServers?.toolguard?.command).toBe("node");
      expect(config.mcpServers?.toolguard?.args).toEqual(["<TOOLPLANE_REPO>/packages/mcp-adapter/dist/server.js"]);
      expect(config.mcpServers?.toolguard?.env?.TOOLGUARD_CORE_URL).toBe("http://127.0.0.1:3660");
      expect(host.limitations.join(" ")).toContain("MCP-routed-only card");
      expect(host.limitations.join(" ")).toContain("Native host tools and direct IDE actions are not intercepted");
    }
  });
});
