import { readFileSync } from "node:fs";

const registry = JSON.parse(readFileSync("feature-flags.json", "utf8"));
const today = new Date().toISOString().slice(0, 10);
const stale = registry.flags.filter((flag) => typeof flag.expiresAt !== "string" || flag.expiresAt < today);

if (stale.length > 0) {
  console.error(`Stale feature flags: ${stale.map((flag) => flag.key).join(", ")}`);
  process.exitCode = 1;
}
