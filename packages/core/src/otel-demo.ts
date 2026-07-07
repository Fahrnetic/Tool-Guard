import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CoreEvent } from "./events.js";
import { createStructuredLogEntry } from "./logger.js";
import { collectToolGuardMetrics } from "./metrics.js";
import { redactJsonValue } from "./redaction.js";
import type { JsonObject, JsonValue } from "./types.js";
import { exportVisibilityOtel, type OTelAttribute, type VisibilityOtelExportResult } from "./visibility-interop.js";
import { stableVisibilityJson } from "./visibility.js";

export interface ToolGuardOtelDemoPayloads {
  readonly traces: VisibilityOtelExportResult;
  readonly otlpTraces: OtlpTracesPayload;
  readonly metrics: OtlpMetricsPayload;
  readonly logs: OtlpLogsPayload;
  readonly ndjsonLogs: readonly string[];
  readonly dashboardQueries: readonly OpenObserveDashboardQuery[];
}

export interface ToolGuardOtelDemoExportResult extends ToolGuardOtelDemoPayloads {
  readonly outputDir: string;
  readonly tracePath: string;
  readonly metricsPath: string;
  readonly logsPath: string;
  readonly ndjsonLogsPath: string;
  readonly dashboardQueriesPath: string;
}

export interface ToolGuardOtelSendResult {
  readonly endpoint: string;
  readonly traces: OtlpPostResult;
  readonly metrics: OtlpPostResult;
  readonly logs: OtlpPostResult;
}

export interface OtlpPostResult {
  readonly signal: "traces" | "metrics" | "logs";
  readonly status: number;
  readonly ok: boolean;
}

export interface OtlpTracesPayload {
  readonly resourceSpans: VisibilityOtelExportResult["resourceSpans"];
}

export interface OtlpMetricsPayload {
  readonly resourceMetrics: readonly [
    {
      readonly resource: { readonly attributes: readonly OTelAttribute[] };
      readonly scopeMetrics: readonly [
        {
          readonly scope: { readonly name: "toolguard.metrics"; readonly version: "1.0.0" };
          readonly metrics: readonly OtlpGaugeMetric[];
        }
      ];
    }
  ];
}

export interface OtlpGaugeMetric {
  readonly name: string;
  readonly description: string;
  readonly unit: "1";
  readonly gauge: {
    readonly dataPoints: readonly [
      {
        readonly asInt: string;
        readonly timeUnixNano: string;
        readonly attributes: readonly OTelAttribute[];
      }
    ];
  };
}

export interface OtlpLogsPayload {
  readonly resourceLogs: readonly [
    {
      readonly resource: { readonly attributes: readonly OTelAttribute[] };
      readonly scopeLogs: readonly [
        {
          readonly scope: { readonly name: "toolguard.logs"; readonly version: "1.0.0" };
          readonly logRecords: readonly OtlpLogRecord[];
        }
      ];
    }
  ];
}

export interface OtlpLogRecord {
  readonly timeUnixNano: string;
  readonly severityText: "INFO" | "WARN" | "ERROR";
  readonly body: { readonly stringValue: string };
  readonly attributes: readonly OTelAttribute[];
}

export interface OpenObserveDashboardQuery {
  readonly title: string;
  readonly backend: "openobserve" | "prometheus" | "loki" | "grafana";
  readonly query: string;
  readonly purpose: string;
}

export async function exportToolGuardOtelDemo(input: {
  readonly events: readonly CoreEvent[];
  readonly outputDir: string;
  readonly serviceName?: string;
}): Promise<ToolGuardOtelDemoExportResult> {
  const payloads = await buildToolGuardOtelDemoPayloads(input.events, input.serviceName ?? "toolguard-local-demo");
  const tracePath = path.join(input.outputDir, "otel-traces.json");
  const metricsPath = path.join(input.outputDir, "otel-metrics.json");
  const logsPath = path.join(input.outputDir, "otel-logs.json");
  const ndjsonLogsPath = path.join(input.outputDir, "otel-logs.ndjson");
  const dashboardQueriesPath = path.join(input.outputDir, "openobserve-dashboard-queries.json");

  await Promise.all([
    writeFile(tracePath, stableVisibilityJson(payloads.otlpTraces), "utf8"),
    writeFile(metricsPath, stableVisibilityJson(payloads.metrics), "utf8"),
    writeFile(logsPath, stableVisibilityJson(payloads.logs), "utf8"),
    writeFile(ndjsonLogsPath, `${payloads.ndjsonLogs.join("\n")}\n`, "utf8"),
    writeFile(dashboardQueriesPath, stableVisibilityJson(payloads.dashboardQueries), "utf8")
  ]);

  return { outputDir: input.outputDir, tracePath, metricsPath, logsPath, ndjsonLogsPath, dashboardQueriesPath, ...payloads };
}

export async function buildToolGuardOtelDemoPayloads(
  events: readonly CoreEvent[],
  serviceName = "toolguard-local-demo"
): Promise<ToolGuardOtelDemoPayloads> {
  const traces = await exportVisibilityOtel({ events, serviceName });
  const logs = buildOtlpLogs(events, serviceName);
  return {
    traces,
    otlpTraces: { resourceSpans: traces.resourceSpans },
    metrics: buildOtlpMetrics(events, serviceName),
    logs,
    ndjsonLogs: buildLokiNdjsonLogs(logs, serviceName),
    dashboardQueries: buildOpenObserveDashboardQueries()
  };
}

export async function sendToolGuardOtelPayloads(input: {
  readonly payloads: ToolGuardOtelDemoPayloads;
  readonly endpoint?: string;
}): Promise<ToolGuardOtelSendResult> {
  const endpoint = normalizeEndpoint(input.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:14318");
  const [traces, metrics, logs] = await Promise.all([
    postOtlp(endpoint, "traces", input.payloads.otlpTraces),
    postOtlp(endpoint, "metrics", input.payloads.metrics),
    postOtlp(endpoint, "logs", input.payloads.logs)
  ]);
  return { endpoint, traces, metrics, logs };
}

export function buildOtlpMetrics(events: readonly CoreEvent[], serviceName = "toolguard-local-demo"): OtlpMetricsPayload {
  const metrics = collectToolGuardMetrics(events);
  const timeUnixNano = unixNano(new Date().toISOString());
  const definitions = [
    ["toolguard_events_total", "Total ToolGuard events recorded.", metrics.eventsTotal],
    ["toolguard_tool_calls_total", "Total ToolGuard tool calls started.", metrics.toolCallsTotal],
    ["toolguard_failures_total", "Total failed ToolGuard tool calls.", metrics.failuresTotal],
    ["toolguard_sanitized_outputs_total", "Total sanitized output events.", metrics.sanitizedOutputsTotal],
    ["toolguard_open_circuits_total", "Total circuit-open events.", metrics.openCircuitsTotal],
    ["toolguard_policy_blocks_total", "Total blocked policy decisions.", metrics.policyBlocksTotal],
    ["toolguard_tool_call_duration_ms_total", "Total observed tool-call duration in milliseconds.", metrics.toolCallDurationMsTotal],
    ["toolguard_tool_call_duration_observations_total", "Total tool-call duration observations.", metrics.toolCallDurationObservationsTotal]
  ] as const;

  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes(serviceName) },
        scopeMetrics: [
          {
            scope: { name: "toolguard.metrics", version: "1.0.0" },
            metrics: definitions.map(([name, description, value]) => ({
              name,
              description,
              unit: "1",
              gauge: {
                dataPoints: [
                  {
                    asInt: String(value),
                    timeUnixNano,
                    attributes: [stringAttribute("toolguard.demo", "openobserve")]
                  }
                ]
              }
            }))
          }
        ]
      }
    ]
  };
}

export function buildOtlpLogs(events: readonly CoreEvent[], serviceName = "toolguard-local-demo"): OtlpLogsPayload {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes(serviceName) },
        scopeLogs: [
          {
            scope: { name: "toolguard.logs", version: "1.0.0" },
            logRecords: events.map(eventToLogRecord)
          }
        ]
      }
    ]
  };
}

export function buildLokiNdjsonLogs(logs: OtlpLogsPayload, serviceName = "toolguard-local-demo"): readonly string[] {
  return logs.resourceLogs.flatMap((resourceLog) =>
    resourceLog.scopeLogs.flatMap((scopeLog) =>
      scopeLog.logRecords.map((record) =>
        JSON.stringify({
          timeUnixNano: record.timeUnixNano,
          level: record.severityText.toLowerCase(),
          message: record.body.stringValue,
          service_name: serviceName,
          ...Object.fromEntries(record.attributes.map((attribute) => [attribute.key, attributeValue(attribute)]))
        })
      )
    )
  );
}

export function buildOpenObserveDashboardQueries(): readonly OpenObserveDashboardQuery[] {
  return [
    {
      title: "Tool call failures by tool",
      backend: "openobserve",
      query:
        "SELECT data_toolName, count(*) AS failures FROM toolguard_logs WHERE event_type = 'tool.call.failed' GROUP BY data_toolName ORDER BY failures DESC",
      purpose: "Shows which tools fail most often during the demo."
    },
    {
      title: "ToolGuard failures total",
      backend: "prometheus",
      query: "toolguard_failures_total",
      purpose: "Shows the Prometheus-compatible failure counter scraped from Core."
    },
    {
      title: "Tool calls total",
      backend: "prometheus",
      query: "toolguard_tool_calls_total",
      purpose: "Shows how many bounded demo tool calls ToolGuard observed."
    },
    {
      title: "Policy blocks total",
      backend: "prometheus",
      query: "toolguard_policy_blocks_total",
      purpose: "Shows destructive or unsafe attempts blocked by policy."
    },
    {
      title: "Open circuits",
      backend: "prometheus",
      query: "toolguard_open_circuits_total",
      purpose: "Shows circuit breaker activity across runs."
    },
    {
      title: "Trace waterfall",
      backend: "openobserve",
      query:
        "SELECT trace_id, span_id, name, start_time, end_time FROM toolguard_traces WHERE trace_id = '<traceId>' ORDER BY start_time ASC",
      purpose: "Shows a single run or tool-call trace from start through failure handling."
    },
    {
      title: "Redacted logs by trace",
      backend: "loki",
      query: '{service_name="toolguard-local-demo"} | json | trace_id="<traceId>"',
      purpose: "Shows how Loki/Grafana can inspect redacted structured logs for the same trace."
    }
  ];
}

function eventToLogRecord(event: CoreEvent): OtlpLogRecord {
  const level =
    event.type === "tool.call.failed" || event.type === "circuit.opened" ? "error" : event.type === "output.sanitized" ? "warn" : "info";
  const context: JsonObject = {
    eventType: event.type,
    runId: event.runId,
    traceId: event.traceId,
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    data: redactJsonValue((event.data ?? {}) as JsonValue) as JsonObject
  };
  const entry = createStructuredLogEntry(level, event.summary, context);

  return {
    timeUnixNano: unixNano(event.occurredAt),
    severityText: entry.level.toUpperCase() as OtlpLogRecord["severityText"],
    body: { stringValue: entry.message },
    attributes: [
      stringAttribute("event_type", event.type),
      stringAttribute("run_id", event.runId),
      stringAttribute("trace_id", event.traceId),
      ...optionalStringAttribute("tool_call_id", event.toolCallId),
      ...optionalStringAttribute("data_toolName", toolNameFromData(event.data as JsonObject | undefined))
    ]
  };
}

function toolNameFromData(data: JsonObject | undefined): string | undefined {
  const value = data?.toolName;
  return typeof value === "string" ? value : undefined;
}

function resourceAttributes(serviceName: string): readonly OTelAttribute[] {
  return [
    stringAttribute("service.name", serviceName),
    stringAttribute("deployment.environment", "local"),
    stringAttribute("toolguard.observability.stack", "openobserve-otel-collector-prometheus-grafana-loki")
  ];
}

function optionalStringAttribute(key: string, value: string | undefined): readonly OTelAttribute[] {
  return value ? [stringAttribute(key, value)] : [];
}

function stringAttribute(key: string, value: string): OTelAttribute {
  return { key, value: { stringValue: value } };
}

function unixNano(isoTime: string): string {
  return String(BigInt(Date.parse(isoTime)) * 1_000_000n);
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

async function postOtlp(endpoint: string, signal: OtlpPostResult["signal"], body: unknown): Promise<OtlpPostResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/v1/${signal}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (response.ok) return { signal, status: response.status, ok: response.ok };
      const text = await response.text();
      lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`OTLP ${signal} export failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function attributeValue(attribute: OTelAttribute): string | boolean | number {
  if ("stringValue" in attribute.value) return attribute.value.stringValue;
  if ("boolValue" in attribute.value) return attribute.value.boolValue;
  return Number(attribute.value.intValue);
}
