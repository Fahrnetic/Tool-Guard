import { readFileSync } from "node:fs";

const docs = ["README.md", "AGENTS.md"].map((file) => [file, readFileSync(file, "utf8")]);
const requiredCommands = ["pnpm install", "pnpm build", "pnpm test", "pnpm verify", "pnpm lint", "pnpm typecheck"];

const missing = [];
for (const command of requiredCommands) {
  if (!docs.some(([, content]) => content.includes(command))) {
    missing.push(command);
  }
}

if (missing.length > 0) {
  console.error(`Missing documented commands: ${missing.join(", ")}`);
  process.exitCode = 1;
}
