#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TMPDIR="${TMPDIR:-/home/zfahrny/Projects/toolplane/.tmp}"

RUN_ID="run_demo_otel_openobserve_seed_v001"
RUN_DIR="${ROOT}/runs/${RUN_ID}"
GRAFANA_DASHBOARD_URL="http://127.0.0.1:33000/d/toolguard-observability/toolguard-observability?orgId=1&from=now-30m&to=now&timezone=browser&refresh=5s"

usage() {
  cat <<'USAGE'
ToolGuard observability live demo checklist

Usage:
  scripts/observability-demo.sh checklist   # print the operator checklist
  scripts/observability-demo.sh preflight   # verify static config and reserved listeners
  scripts/observability-demo.sh up          # launch the Docker observability stack
  scripts/observability-demo.sh demo        # run the deterministic live demo
  scripts/observability-demo.sh validate    # run fast backend validation checks
  scripts/observability-demo.sh offline     # generate offline OTEL artifacts only
  scripts/observability-demo.sh down        # stop the Docker observability stack

Exact happy-path commands:
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:config
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp node scripts/check-observability-stack.mjs
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:up
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm demo:openobserve
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:down

Offline fallback command:
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm demo:otel
USAGE
}

print_checklist() {
  cat <<CHECKLIST
# ToolGuard Observability Demo

## 1. Preflight and launch

Run these from the repository root:

\`\`\`bash
TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:config
TMPDIR=/home/zfahrny/Projects/toolplane/.tmp node scripts/check-observability-stack.mjs
TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:up
TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm demo:openobserve
\`\`\`

Keep \`pnpm demo:openobserve\` running while presenting so Prometheus can scrape
Core metrics at \`http://127.0.0.1:3660/metrics\`. Stop it with \`Ctrl+C\` after
the walkthrough, then clean up:

\`\`\`bash
TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:down
\`\`\`

## 2. Demo URLs

| Surface | URL | Expected use |
| --- | --- | --- |
| OpenObserve | http://127.0.0.1:5080 | Unified trace, log, and metric exploration |
| Grafana dashboard | ${GRAFANA_DASHBOARD_URL} | Polished live-demo dashboard |
| Prometheus | http://127.0.0.1:39090 | Raw metrics, rules, and targets |
| Loki API | http://127.0.0.1:33100 | Redacted structured log backend |
| OTLP HTTP Collector | http://127.0.0.1:14318 | Trace, metric, and log ingestion |
| OTLP gRPC Collector | 127.0.0.1:14317 | gRPC ingestion endpoint |
| Collector self metrics | http://127.0.0.1:18888/metrics | Collector internal health |
| Collector exported metrics | http://127.0.0.1:18889/metrics | OTLP metrics exposed to Prometheus |
| Core metrics | http://127.0.0.1:3660/metrics | ToolGuard metrics while the demo runs |

## 3. Credentials

\`pnpm observability:config\` creates \`.tmp/openobserve.env\` with local runtime
credentials. Do not print or commit that file.

- OpenObserve login: values from \`OPENOBSERVE_ROOT_USER_EMAIL\` and
  \`OPENOBSERVE_ROOT_USER_PASSWORD\` in \`.tmp/openobserve.env\`.
- Grafana login: username \`admin\`, password from \`GRAFANA_ADMIN_PASSWORD\` in
  \`.tmp/openobserve.env\`.

Use this only to load variables locally, without echoing secrets:

\`\`\`bash
set -a
. .tmp/openobserve.env
set +a
\`\`\`

## 4. Grafana panel checklist

Open the dashboard in a standard presentation viewport, such as 1440x1000. The
dashboard should use the dark theme, readable labels, no query errors, and no
visible \`No data\` placeholders after a scrape delay.

Expected panels and outcomes:

- Tool Calls Observed: stat card shows the deterministic demo tool-call count.
- Failures Caught: stat card shows caught ToolGuard failures.
- Sanitized Outputs: stat card shows sanitized outputs, expected non-zero.
- Policy Blocks: stat card shows blocked destructive or unsafe calls.
- Open Circuits: stat card is present, often zero for the happy path.
- Redacted Structured Logs: Loki logs show structured events for \`${RUN_ID}\`.
- Failure Drilldown: error rows are visible after \`| json | detected_level="ERROR"\`.
- Sanitization Evidence: \`output.sanitized\` rows show redacted payload handling.
- Pipeline Health: Prometheus \`up\` values show Core, Collector self metrics, and
  Collector exported metrics.

The previous visual validation observed useful values such as tool calls \`3\`,
failures \`3\`, sanitized outputs \`1\`, policy blocks \`1\`, open circuits \`0\`,
event flow \`32\`, and average duration near \`82.7 ms\`. Exact values may vary
slightly, but panels should be populated and demo-useful.

## 5. Backend validation checks

Run these while \`pnpm demo:openobserve\` is still running:

\`\`\`bash
curl -fsS http://127.0.0.1:5080
curl -fsS http://127.0.0.1:33000/api/health
curl -fsS http://127.0.0.1:39090/-/ready
curl -fsS http://127.0.0.1:33100/ready
curl -fsS http://127.0.0.1:18888/metrics
curl -fsS http://127.0.0.1:18889/metrics | grep 'toolguard_'
curl -fsS http://127.0.0.1:3660/metrics | grep 'toolguard_'
curl -fsS 'http://127.0.0.1:39090/api/v1/query?query=toolguard_tool_calls_total'
curl -fsS 'http://127.0.0.1:39090/api/v1/query?query=toolguard_failures_total'
curl -fsS 'http://127.0.0.1:39090/api/v1/query?query=toolguard_sanitized_outputs_total'
curl -fsS 'http://127.0.0.1:39090/api/v1/query?query=toolguard_policy_blocks_total'
curl -fsS 'http://127.0.0.1:39090/api/v1/query?query=toolguard_open_circuits_total'
curl -fsS 'http://127.0.0.1:39090/api/v1/query?query=toolguard:failure_rate5m'
curl -fsS 'http://127.0.0.1:39090/api/v1/query?query=toolguard:tool_call_avg_duration_ms5m'
curl -fsS 'http://127.0.0.1:39090/api/v1/rules' | grep 'toolguard'
curl -G -fsS 'http://127.0.0.1:33100/loki/api/v1/query' --data-urlencode 'query={service_name="toolguard-local-demo"} | json'
curl -G -fsS 'http://127.0.0.1:33100/loki/api/v1/query' --data-urlencode 'query={service_name="toolguard-local-demo"} | json | detected_level="ERROR"'
curl -G -fsS 'http://127.0.0.1:33100/loki/api/v1/query' --data-urlencode 'query={service_name="toolguard-local-demo"} | json | event_type="output.sanitized"'
curl -fsS 'http://127.0.0.1:33100/loki/api/v1/labels'
\`\`\`

Expected artifact files:

\`\`\`bash
ls -lh runs/${RUN_ID}/otel-traces.json \\
       runs/${RUN_ID}/otel-metrics.json \\
       runs/${RUN_ID}/otel-logs.json \\
       runs/${RUN_ID}/otel-logs.ndjson \\
       runs/${RUN_ID}/openobserve-dashboard-queries.json
\`\`\`

OpenObserve saved query patterns are copied to
\`runs/${RUN_ID}/openobserve-dashboard-queries.json\`. Use them to locate logs,
traces, metrics, and the run drilldown for \`${RUN_ID}\`.

## 6. Redaction and correlation checks

Secret-shaped values must be absent from artifacts, Loki responses, OpenObserve
responses, and screenshots. Correlation fields must be present in structured
payloads but not promoted to Loki labels.

\`\`\`bash
grep -RInE 'sk-[A-Za-z0-9]{20,}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|Authorization: Bearer|api[_-]?key[=:]' runs/${RUN_ID} && echo 'unexpected secret-shaped value found' && exit 1 || true
grep -RInE '"run_id"|"trace_id"|"tool_call_id"' runs/${RUN_ID}
if curl -fsS 'http://127.0.0.1:33100/loki/api/v1/labels' | grep -E 'run_id|trace_id|tool_call_id'; then
  echo 'unexpected high-cardinality Loki label found'
  exit 1
fi
\`\`\`

For a representative row, match the same \`run_id\`, \`trace_id\`, and
\`tool_call_id\` across:

1. \`runs/${RUN_ID}/otel-logs.ndjson\` or \`otel-logs.json\`
2. Loki query \`{service_name="toolguard-local-demo"} | json\`
3. OpenObserve run drilldown or trace waterfall query

## 7. Safe reruns and cleanup

Safe normal rerun:

\`\`\`bash
# Stop the foreground demo with Ctrl+C first.
TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm demo:openobserve
\`\`\`

If a previous run was interrupted, use targeted mission-owned cleanup only:

\`\`\`bash
TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:down
TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:up
TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm demo:openobserve
\`\`\`

If Loki misses fresh deterministic NDJSON records because Promtail tailed the
same path to EOF, recreate only the mission-owned Promtail container:

\`\`\`bash
TMPDIR=/home/zfahrny/Projects/toolplane/.tmp docker compose --env-file /home/zfahrny/Projects/toolplane/.tmp/openobserve.env -f /home/zfahrny/Projects/toolplane/observability/openobserve/docker-compose.yml up -d --force-recreate promtail
\`\`\`

Do not run broad cleanup such as \`git clean\` or broad \`rm -rf\`. Preserve run
evidence under \`runs/${RUN_ID}/\`.

## 8. Fallback troubleshooting

- Docker unavailable: run \`docker --version\`, \`docker compose version\`, and
  \`docker info\`. If daemon access requires sudo, password entry, or host setup,
  stop and report that blocker. Use the offline fallback below for local
  artifacts only.
- Reserved port conflict: check \`5080 14317 14318 18888 18889 39090 33100 33000
  3660\`. Stop only mission-owned services with
  \`TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:down\`.
- Empty Grafana panels: keep \`pnpm demo:openobserve\` running, wait for scrape
  delay, then check \`http://127.0.0.1:3660/metrics\` and Prometheus targets.
- Missing Loki logs: confirm \`runs/${RUN_ID}/otel-logs.ndjson\` exists, check
  \`http://127.0.0.1:33100/ready\`, and use the targeted Promtail recreate
  command above if deterministic reruns reuse the same file path.
- Missing Prometheus rules: rerun
  \`TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:config\`, then
  check \`http://127.0.0.1:39090/api/v1/rules\` for \`toolguard\` rules.
- Collector export failures: ensure \`pnpm observability:up\` completed, then
  check \`http://127.0.0.1:14318\`, \`http://127.0.0.1:18888/metrics\`, and
  \`http://127.0.0.1:18889/metrics\` before rerunning the demo.
- OpenObserve auth failures: use credentials from \`.tmp/openobserve.env\`. If
  credentials were regenerated but the Docker volume still has stale auth state,
  reset only mission-owned OpenObserve resources and rerun telemetry.
- Screenshot capture failures: use the Grafana URL above, a 1440x1000 viewport,
  last 30 minutes time range, and 5s refresh. Record URL, viewport, timestamp,
  refresh state, and \`${RUN_ID}\`.
- Offline artifact fallback:
  \`TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm demo:otel\`. This generates
  local OTEL files without Docker, Collector, OpenObserve, Grafana, Prometheus,
  or Loki.
CHECKLIST
}

run_preflight() {
  cd "${ROOT}"
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:config
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp node scripts/check-observability-stack.mjs
  for port in 5080 14317 14318 18888 18889 39090 33100 33000 3660; do
    if ss -ltn "( sport = :${port} )" | grep -q ":${port}"; then
      echo "Port ${port} already has a listener. Confirm it is mission-owned before launching."
    fi
  done
}

run_up() {
  cd "${ROOT}"
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:up
}

run_demo() {
  cd "${ROOT}"
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm demo:openobserve
}

run_validate() {
  cd "${ROOT}"
  echo "Checking service endpoints and demo metrics..."
  curl -fsS http://127.0.0.1:5080 >/dev/null
  curl -fsS http://127.0.0.1:33000/api/health >/dev/null
  curl -fsS http://127.0.0.1:39090/-/ready >/dev/null
  curl -fsS http://127.0.0.1:33100/ready >/dev/null
  curl -fsS http://127.0.0.1:18888/metrics >/dev/null
  curl -fsS http://127.0.0.1:18889/metrics | grep 'toolguard_'
  curl -fsS http://127.0.0.1:3660/metrics | grep 'toolguard_'
  curl -fsS 'http://127.0.0.1:39090/api/v1/rules' | grep 'toolguard'
  curl -G -fsS 'http://127.0.0.1:33100/loki/api/v1/query' --data-urlencode 'query={service_name="toolguard-local-demo"} | json' >/dev/null
  if curl -fsS 'http://127.0.0.1:33100/loki/api/v1/labels' | grep -E 'run_id|trace_id|tool_call_id'; then
    echo "Unexpected high-cardinality Loki correlation label found."
    return 1
  fi
  test -s "${RUN_DIR}/otel-traces.json"
  test -s "${RUN_DIR}/otel-metrics.json"
  test -s "${RUN_DIR}/otel-logs.json"
  test -s "${RUN_DIR}/otel-logs.ndjson"
  test -s "${RUN_DIR}/openobserve-dashboard-queries.json"
  grep -RInE '"run_id"|"trace_id"|"tool_call_id"' "${RUN_DIR}" >/dev/null
  if grep -RInE 'sk-[A-Za-z0-9]{20,}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|Authorization: Bearer|api[_-]?key[=:]' "${RUN_DIR}"; then
    echo "Unexpected secret-shaped value found in ${RUN_DIR}."
    return 1
  fi
  echo "Fast validation checks passed for ${RUN_ID}."
}

run_offline() {
  cd "${ROOT}"
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm demo:otel
}

run_down() {
  cd "${ROOT}"
  TMPDIR=/home/zfahrny/Projects/toolplane/.tmp pnpm observability:down
}

case "${1:-checklist}" in
  checklist) print_checklist ;;
  preflight) run_preflight ;;
  up) run_up ;;
  demo) run_demo ;;
  validate) run_validate ;;
  offline) run_offline ;;
  down) run_down ;;
  help|-h|--help) usage ;;
  *)
    usage
    exit 64
    ;;
esac
