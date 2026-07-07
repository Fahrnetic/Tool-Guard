import { readFileSync } from "node:fs";

const ruleset = JSON.parse(readFileSync(new URL("../.github/rulesets/main-branch-protection.json", import.meta.url), "utf8"));
const rules = new Map(ruleset.rules.map((rule) => [rule.type, rule]));
const statusChecks = new Set(rules.get("required_status_checks")?.parameters?.required_status_checks?.map((check) => check.context) ?? []);

const requiredRuleTypes = ["pull_request", "required_status_checks", "required_linear_history", "deletion", "non_fast_forward"];
const requiredChecks = ["verify", "test:coverage", "Security / gitleaks", "Security / codeql", "Security / dast"];
const missing = [
  ruleset.enforcement === "active" ? null : "ruleset enforcement must be active",
  ruleset.conditions?.ref_name?.include?.includes("refs/heads/main") ? null : "ruleset must target refs/heads/main",
  ...requiredRuleTypes.map((type) => (rules.has(type) ? null : `missing ${type} rule`)),
  rules.get("pull_request")?.parameters?.require_code_owner_review ? null : "pull requests must require CODEOWNERS review",
  rules.get("pull_request")?.parameters?.required_review_thread_resolution ? null : "pull requests must require conversation resolution",
  ...requiredChecks.map((context) => (statusChecks.has(context) ? null : `missing required status check: ${context}`))
].filter(Boolean);

if (missing.length > 0) {
  console.error(`Branch protection ruleset is incomplete:\n- ${missing.join("\n- ")}`);
  process.exit(1);
}
