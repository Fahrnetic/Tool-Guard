import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../backlog-health.config.json", import.meta.url), "utf8"));
const errors = [];

const requireNonEmptyArray = (key) => {
  if (
    !Array.isArray(config[key]) ||
    config[key].length === 0 ||
    config[key].some((value) => typeof value !== "string" || value.length === 0)
  ) {
    errors.push(`${key} must be a non-empty string array`);
  }
};

requireNonEmptyArray("priorityLabels");
requireNonEmptyArray("typeLabels");
requireNonEmptyArray("areaLabels");
requireNonEmptyArray("criticalFailureLabels");
requireNonEmptyArray("allowedStates");

if (typeof config.maxUnlabeledOpenIssues !== "number" || config.maxUnlabeledOpenIssues < 0) {
  errors.push("maxUnlabeledOpenIssues must be a non-negative number");
}

if (typeof config.maxIssuesMissingType !== "number" || config.maxIssuesMissingType < 0) {
  errors.push("maxIssuesMissingType must be a non-negative number");
}

for (const label of config.priorityLabels ?? []) {
  if (typeof config.stalenessDays?.[label] !== "number" || config.stalenessDays[label] < 1) {
    errors.push(`stalenessDays.${label} must be a positive number`);
  }
}

if (typeof config.stalenessDays?.default !== "number" || config.stalenessDays.default < 1) {
  errors.push("stalenessDays.default must be a positive number");
}

for (const label of config.criticalFailureLabels ?? []) {
  if (!config.priorityLabels?.includes(label)) {
    errors.push(`critical failure label ${label} must be listed in priorityLabels`);
  }
}

if (errors.length > 0) {
  console.error(`Backlog health config is invalid:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
