import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");

const scripts = packageJson.scripts ?? {};
const failures = [];

function requireContains(label, value, expected) {
  if (!value.includes(expected)) {
    failures.push(`${label} must include ${expected}`);
  }
}

function requireAbsent(label, value, forbiddenPattern) {
  if (forbiddenPattern.test(value)) {
    failures.push(`${label} must not match ${forbiddenPattern}`);
  }
}

const proofScript = scripts["proof:integrations"] ?? "";
const verifyScript = scripts.verify ?? "";
const qualityScript = scripts.quality ?? "";

requireContains("proof:integrations", proofScript, "doctor:integrations");
requireContains("proof:integrations", proofScript, "integration-doctor.test.ts");
requireContains("proof:integrations", proofScript, "api-openapi-drift.test.ts");
requireContains("proof:integrations", proofScript, "api-runtime-contract.test.ts");
requireContains("verify", verifyScript, "pnpm proof:integrations");
requireContains("quality", qualityScript, "node scripts/check-validation-gate.mjs");
requireContains("ci workflow", ciWorkflow, "pnpm proof:integrations");

for (const tool of ["black", "coverage", "mypy", "radon", "ruff", "vulture"]) {
  requireContains("ci python quality install step", ciWorkflow, tool);
}

const forbiddenProofDependencies = /\b(docker|docker-compose|compose|playwright|agent-browser|screenshot)\b/i;
requireAbsent("proof:integrations", proofScript, forbiddenProofDependencies);

const serializedHeavyValidators = [
  "pnpm docs:check",
  "pnpm proof:integrations",
  "pnpm format:check",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm test",
  "pnpm quality",
  "pnpm build"
];

let previousIndex = -1;
for (const command of serializedHeavyValidators) {
  const index = verifyScript.indexOf(command);
  if (index === -1) {
    failures.push(`verify must include serialized command ${command}`);
    continue;
  }
  if (index <= previousIndex) {
    failures.push(`verify must run ${command} after the previous heavy validator`);
  }
  previousIndex = index;
}

if (/[;&|]\s*(pnpm\s+(proof:integrations|test|quality|build)|concurrently|npm-run-all)/.test(verifyScript.replaceAll("&&", ""))) {
  failures.push("verify must serialize heavy validators with && and must not use background or parallel runners");
}

if (failures.length > 0) {
  console.error("Validation gate wiring check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
}
