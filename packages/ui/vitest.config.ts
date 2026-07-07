import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["tests/**/*.{test.ts,test.tsx}"],
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 1,
        functions: 1,
        branches: 1,
        statements: 1
      }
    }
  }
});
