import {
  generateHostConfigSnippets as generateSharedHostConfigSnippets,
  type HostConfigSnippet,
  type SetupSnippetOptions,
  type SupportedMcpHostId
} from "@toolplane/core/setup-snippets";

export interface HostConfigSnippetOptions {
  readonly toolplaneRepoPath?: string;
  readonly command?: string;
  readonly serverModulePath?: string;
  readonly coreUrl?: string;
  readonly profilePlaceholder?: string;
}

export type { HostConfigSnippet, SupportedMcpHostId };

export function generateHostConfigSnippets(options: HostConfigSnippetOptions = {}): readonly HostConfigSnippet[] {
  const sharedOptions: SetupSnippetOptions = {
    repoPlaceholder: options.toolplaneRepoPath ?? "<TOOLPLANE_REPO>",
    coreUrl: options.coreUrl ?? "http://127.0.0.1:3660",
    profilePlaceholder: options.profilePlaceholder ?? "<TOOLGUARD_PROFILE>"
  };
  return generateSharedHostConfigSnippets(sharedOptions).map((snippet) => {
    if (!options.command && !options.serverModulePath) return snippet;
    const config = JSON.parse(snippet.configJson) as {
      mcpServers?: { toolguard?: { command?: string; args?: string[] } };
    };
    const server = config.mcpServers?.toolguard;
    if (server) {
      if (options.command) server.command = options.command;
      if (options.serverModulePath) server.args = [options.serverModulePath];
    }
    return { ...snippet, configJson: JSON.stringify(config, null, 2) };
  });
}
