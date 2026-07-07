# ToolGuard Observability Demo

This local stack demonstrates the full observability path suggested for the project:

- OpenTelemetry APIs and OTLP-shaped logs, metrics, and traces
- OpenObserve as the all-in-one demo backend
- OpenTelemetry Collector as the production-style middle layer
- Prometheus scraping ToolGuard `/metrics`
- Grafana dashboards over Prometheus and Loki
- Loki log aggregation for redacted ToolGuard logs

All services bind to `127.0.0.1` and avoid ToolGuard demo ports `3660-3669`.

## Run

```bash
docker compose -f observability/openobserve/docker-compose.yml up
pnpm demo:otel
pnpm dev:core
```

Open:

- OpenObserve: <http://127.0.0.1:5080>, login `${OPENOBSERVE_ROOT_USER_EMAIL:-root@example.com}` / `${OPENOBSERVE_ROOT_USER_PASSWORD:-toolguard-local-demo}`
- Prometheus: <http://127.0.0.1:39090>
- Grafana: <http://127.0.0.1:33000>, login `admin` / `admin`
- Loki API: <http://127.0.0.1:33100>
- OTLP HTTP collector: <http://127.0.0.1:14318>
- OTLP gRPC collector: `127.0.0.1:14317`

`pnpm demo:otel` writes these local evidence files under `runs/<runId>/`:

- `otel-traces.json`
- `otel-metrics.json`
- `otel-logs.json`
- `openobserve-dashboard-queries.json`

## OpenObserve upload examples

OpenObserve accepts OTLP HTTP under `/api/default/v1/{traces,metrics,logs}`. The local demo writes OTLP JSON payloads that can be uploaded with:

```bash
RUN_DIR=runs/run_demo_otel_openobserve_seed_v001
OPENOBSERVE_ROOT_USER_EMAIL="${OPENOBSERVE_ROOT_USER_EMAIL:-root@example.com}"
OPENOBSERVE_ROOT_USER_PASSWORD="${OPENOBSERVE_ROOT_USER_PASSWORD:-toolguard-local-demo}"
AUTH="$(printf '%s:%s' "${OPENOBSERVE_ROOT_USER_EMAIL}" "${OPENOBSERVE_ROOT_USER_PASSWORD}" | base64 -w0)"

curl -H "Authorization: Basic ${AUTH}" -H "Content-Type: application/json" \
  --data-binary "@${RUN_DIR}/otel-traces.json" \
  http://127.0.0.1:5080/api/default/v1/traces

curl -H "Authorization: Basic ${AUTH}" -H "Content-Type: application/json" \
  --data-binary "@${RUN_DIR}/otel-metrics.json" \
  http://127.0.0.1:5080/api/default/v1/metrics

curl -H "Authorization: Basic ${AUTH}" -H "Content-Type: application/json" \
  --data-binary "@${RUN_DIR}/otel-logs.json" \
  http://127.0.0.1:5080/api/default/v1/logs
```

## Demo queries

- Failure frequency: `SELECT data_toolName, count(*) AS failures FROM toolguard_logs WHERE event_type = 'tool.call.failed' GROUP BY data_toolName`
- Trace waterfall: `SELECT trace_id, span_id, name, start_time, end_time FROM toolguard_traces WHERE trace_id = '<traceId>' ORDER BY start_time ASC`
- Prometheus failures: `toolguard_failures_total`
- Loki logs: `{service_name="toolguard-local-demo"} | json`

## Production mapping

The local OpenObserve-only path is intentionally simple for demos. A production deployment would usually send app telemetry to the OpenTelemetry Collector first, then route traces, metrics, and logs to one or more backends such as OpenObserve, Prometheus, Grafana, and Loki.
