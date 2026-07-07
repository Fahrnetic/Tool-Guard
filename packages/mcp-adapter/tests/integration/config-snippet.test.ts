import { describe, expect, it } from "vitest";
import { generateHostConfigSnippets } from "../../src/index.js";

describe("MCP adapter integration snippets", () => {
  it("generates copyable host setup snippets without secrets", () => {
    const snippets = generateHostConfigSnippets({ command: "toolguard" });

    expect(snippets.length).toBeGreaterThan(0);
    expect(JSON.stringify(snippets)).not.toMatch(/token|secret|password/i);
  });
});
