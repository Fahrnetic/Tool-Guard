import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_DISPLAY_NAME, PROJECT_NAME } from "../src/index.js";

const forbiddenImports = [
  "@modelcontextprotocol/",
  "react",
  "react-dom",
  "vite",
  "tailwind",
  "packages/ui",
  "packages/mcp-adapter",
  "langgraph",
  "autogen",
  "crewai"
];

describe("core package boundaries", () => {
  it("centralizes project and display names", () => {
    expect(PROJECT_NAME).toBe("Toolplane");
    expect(PRODUCT_DISPLAY_NAME).toBe("ToolGuard");
  });

  it("does not import adapter, UI, or framework-specific code", async () => {
    const sourceFiles = [
      "src/events.ts",
      "src/evidence.ts",
      "src/ids.ts",
      "src/index.ts",
      "src/product.ts",
      "src/registry.ts",
      "src/server.ts",
      "src/session.ts",
      "src/types.ts"
    ];

    for (const sourceFile of sourceFiles) {
      const contents = await readFile(path.join(process.cwd(), sourceFile), "utf8");
      for (const forbiddenImport of forbiddenImports) {
        expect(contents, `${sourceFile} imports ${forbiddenImport}`).not.toContain(forbiddenImport);
      }
    }
  });
});
