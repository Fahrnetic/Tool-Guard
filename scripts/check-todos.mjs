import { spawnSync } from "node:child_process";

const result = spawnSync("git", ["grep", "-nE", "TODO|FIXME", "--", "."], { encoding: "utf8" });
const output = result.status === 0 ? result.stdout.trim() : "";

const violations = output ? output.split("\n").filter((line) => !/TODO\([A-Z]+-[0-9]+\)|FIXME\([A-Z]+-[0-9]+\)/.test(line)) : [];

if (violations.length > 0) {
  console.error("TODO/FIXME markers must reference an issue like TODO(TG-123):");
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
