import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 1,
        functions: 1,
        branches: 1,
        statements: 1
      }
    },
    restoreMocks: true
  }
});
