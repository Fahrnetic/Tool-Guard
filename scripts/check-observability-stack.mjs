import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url);
const files = {
  compose: "observability/openobserve/docker-compose.yml",
  collector: "observability/openobserve/otel-collector-config.yml",
  prometheus: "observability/prometheus/prometheus.yml",
  prometheusRules: "observability/prometheus/rules/toolguard.yml",
  promtail: "observability/promtail/promtail-config.yml",
  datasources: "observability/grafana/provisioning/datasources/datasources.yml",
  dashboard: "observability/grafana/dashboards/toolguard-overview.json",
  savedQueries: "observability/openobserve/saved-queries.json",
  readme: "observability/openobserve/README.md",
  packageJson: "package.json"
};
const contents = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, readFileSync(new URL(file, root), "utf8")]));
const errors = [];

for (const service of ["openobserve", "otel-collector", "prometheus", "loki", "promtail", "grafana"]) {
  requireIncludes(contents.compose, `${service}:`, `compose service ${service}`);
}
requireIncludes(contents.compose, "127.0.0.1:14318:4318", "loopback OTLP HTTP port");
requireIncludes(contents.compose, "127.0.0.1:18889:8889", "loopback collector Prometheus exporter port");
requireIncludes(contents.compose, "OPENOBSERVE_AUTH_HEADER", "collector OpenObserve auth env");
requireIncludes(
  contents.compose,
  "OPENOBSERVE_ROOT_USER_PASSWORD:?Set OPENOBSERVE_ROOT_USER_PASSWORD via .tmp/openobserve.env",
  "OpenObserve runtime password requirement"
);
requireIncludes(
  contents.compose,
  "GRAFANA_ADMIN_PASSWORD:?Set GRAFANA_ADMIN_PASSWORD via .tmp/openobserve.env",
  "Grafana runtime password requirement"
);
const formerOpenObserveDefault = ["ToolGuard", "local", "demo1!"].join("-");
const formerGrafanaDefault = ["GF_SECURITY_ADMIN_PASSWORD", "admin"].join(": ");
for (const forbiddenDefault of [formerOpenObserveDefault, formerGrafanaDefault]) {
  requireExcludes(contents.compose, forbiddenDefault, `committed credential default ${forbiddenDefault}`);
}
for (const mount of [
  "./otel-collector-config.yml:/etc/otelcol/config.yml:ro,z",
  "../prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro,z",
  "../loki/loki-config.yml:/etc/loki/config.yml:ro,z",
  "../promtail/promtail-config.yml:/etc/promtail/config.yml:ro,z"
]) {
  requireIncludes(contents.compose, mount, `SELinux-readable bind mount ${mount}`);
}
requireIncludes(contents.packageJson, '"observability:config"', "root observability:config script");
requireIncludes(
  readFileSync(new URL("scripts/openobserve-stack.mjs", root), "utf8"),
  "generateStrongCredential()",
  "OpenObserve stack runtime credential generation"
);
requireIncludes(
  readFileSync(new URL("scripts/openobserve-stack.mjs", root), "utf8"),
  "isOpenObserveCompatibleCredential",
  "OpenObserve password complexity guard"
);
requireIncludes(
  readFileSync(new URL("scripts/openobserve-stack.mjs", root), "utf8"),
  "formatEnvValue(authHeader)",
  "shell-compatible OpenObserve auth header env output"
);

requireIncludes(contents.collector, "receivers:", "collector receivers");
requireIncludes(contents.collector, "otlp:", "collector OTLP receiver");
requireIncludes(contents.collector, "memory_limiter:", "collector memory limiter processor");
requireIncludes(contents.collector, "resource:", "collector resource processor");
requireIncludes(contents.collector, "batch:", "collector batch processor");
requireIncludes(contents.collector, "otlphttp/openobserve:", "collector OpenObserve exporter");
requireIncludes(contents.collector, "${env:OPENOBSERVE_AUTH_HEADER}", "collector auth env expansion");
requireIncludes(contents.collector, "endpoint: 0.0.0.0:8889", "collector Prometheus exporter endpoint");
requireIncludes(contents.collector, "host: 0.0.0.0", "collector self telemetry host");
requireIncludes(contents.collector, "port: 8888", "collector self telemetry port");
for (const pipeline of [
  "processors: [memory_limiter, resource, batch]",
  "exporters: [otlphttp/openobserve, debug]",
  "exporters: [otlphttp/openobserve, prometheus, debug]",
  "exporters: [otlphttp/openobserve, otlphttp/loki, debug]"
]) {
  requireIncludes(contents.collector, pipeline, `collector pipeline ${pipeline}`);
}
requireIncludes(contents.collector, "otlphttp/loki:", "collector Loki OTLP HTTP exporter");
requireIncludes(contents.collector, "endpoint: http://loki:3100/otlp", "collector Loki OTLP endpoint");

for (const target of ["host.docker.internal:3660", "otel-collector:8888", "otel-collector:8889"]) {
  requireIncludes(contents.prometheus, target, `Prometheus scrape target ${target}`);
}
requireIncludes(contents.prometheus, "rule_files:", "Prometheus rule_files");
requireIncludes(contents.prometheus, "/etc/prometheus/rules/*.yml", "Prometheus rules reference");
for (const rule of ["toolguard:failure_rate5m", "toolguard:open_circuits_rate5m", "ToolGuardCoreUnavailable"]) {
  requireIncludes(contents.prometheusRules, rule, `Prometheus rule ${rule}`);
}
requireIncludes(
  contents.prometheusRules,
  "record: toolguard:tool_call_avg_duration_ms5m",
  "Prometheus average tool-call duration recording rule"
);
requireIncludes(
  contents.prometheusRules,
  "toolguard_tool_call_duration_ms_total / toolguard_tool_call_duration_observations_total",
  "Prometheus average tool-call duration numerator and denominator"
);
requireIncludes(
  contents.prometheusRules,
  "unless toolguard_tool_call_duration_observations_total == 0",
  "Prometheus average tool-call duration zero-observation guard"
);
requireExcludes(
  contents.prometheusRules,
  "clamp_min(rate(toolguard_tool_call_duration_observations_total[5m]), 1)",
  "Prometheus average duration observation-rate clamp"
);

requireIncludes(contents.promtail, "__path__: /workspace/runs/**/otel-logs.ndjson", "Promtail NDJSON path");
for (const label of ["event_type:", "level:", "service_name:"]) {
  requireIncludes(contents.promtail, label, `Promtail label ${label}`);
}
const promtailLabelsBlock = contents.promtail.match(/- labels:\n(?<labels>[\s\S]*?)(?:\n\s+- [a-z_]+:|\n\S|$)/)?.groups?.labels ?? "";
requireExcludes(promtailLabelsBlock, "run_id:", "Promtail high-cardinality run_id label");
requireExcludes(promtailLabelsBlock, "trace_id:", "Promtail high-cardinality trace_id label");
requireExcludes(promtailLabelsBlock, "tool_call_id:", "Promtail high-cardinality tool_call_id label");
requireIncludes(contents.collector, "transform/loki_body:", "Collector Loki structured body transform");
requireIncludes(contents.collector, "attributes/loki_low_cardinality:", "Collector Loki low-cardinality attributes processor");
requireIncludes(contents.collector, "action: delete", "Collector Loki high-cardinality attribute deletion");

requireIncludes(contents.datasources, "uid: Prometheus", "Grafana Prometheus UID");
requireIncludes(contents.datasources, "uid: Loki", "Grafana Loki UID");
requireIncludes(contents.dashboard, '"uid": "Prometheus"', "dashboard Prometheus UID reference");
requireIncludes(contents.dashboard, '"uid": "Loki"', "dashboard Loki UID reference");
requireIncludes(contents.dashboard, "toolguard_open_circuits_total", "dashboard open-circuit panel");
for (const title of [
  "Tool Calls Observed",
  "Failures Caught",
  "Sanitized Outputs",
  "Policy Blocks",
  "Redacted Structured Logs",
  "How to Demo"
]) {
  requireIncludes(contents.dashboard, title, `dashboard panel ${title}`);
}
for (const query of ["ToolGuard failed calls by tool", "ToolGuard trace waterfall", "ToolGuard sanitized outputs"]) {
  requireIncludes(contents.savedQueries, query, `OpenObserve saved query ${query}`);
}

for (const command of ["pnpm observability:up", "pnpm demo:openobserve", "pnpm observability:down"]) {
  requireIncludes(contents.readme, command, `observability README command ${command}`);
}
requireIncludes(contents.packageJson, '"observability:up"', "root observability:up script");
requireIncludes(contents.packageJson, '"demo:openobserve"', "root demo:openobserve script");

const dockerCheck = spawnSync("docker", ["compose", "-f", new URL(files.compose, root).pathname, "config"], {
  env: {
    ...process.env,
    OPENOBSERVE_ROOT_USER_PASSWORD: process.env.OPENOBSERVE_ROOT_USER_PASSWORD ?? "check-only-openobserve-runtime-password-placeholder",
    GRAFANA_ADMIN_PASSWORD: process.env.GRAFANA_ADMIN_PASSWORD ?? "check-only-grafana-runtime-password-placeholder"
  },
  stdio: "ignore"
});
if (dockerCheck.error && dockerCheck.error.code !== "ENOENT") {
  errors.push(`docker compose config could not run: ${dockerCheck.error.message}`);
}
if (!dockerCheck.error && dockerCheck.status !== 0) {
  errors.push("docker compose config failed");
}

if (errors.length > 0) {
  console.error(`Observability stack config is incomplete:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

function requireIncludes(content, needle, label) {
  if (!content.includes(needle)) errors.push(`missing ${label}`);
}

function requireExcludes(content, needle, label) {
  if (content.includes(needle)) errors.push(`unexpected ${label}`);
}
