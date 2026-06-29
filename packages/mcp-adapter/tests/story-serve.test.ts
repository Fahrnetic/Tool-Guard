import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDemoStoryModePayload } from "@toolplane/core";

describe("story mode serve orchestration", () => {
  it("wires pnpm demo:serve to the persistent story mode server entrypoint", async () => {
    const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
    const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const adapterPackage = JSON.parse(await readFile(path.join(repoRoot, "packages", "mcp-adapter", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const story = buildDemoStoryModePayload();

    expect(rootPackage.scripts["demo:serve"]).toBe("pnpm --filter @toolplane/mcp-adapter demo:serve");
    expect(adapterPackage.scripts["demo:serve"]).toContain("node dist/story-serve.js");
    expect(story.processHygiene.cleanupOnExit).toContain("SIGINT/SIGTERM");
    expect(story.processHygiene.startSurfaces).toEqual(
      expect.arrayContaining([
        "Core/API/SSE on http://127.0.0.1:3660",
        "UI on http://127.0.0.1:3661"
      ])
    );
  });
});
