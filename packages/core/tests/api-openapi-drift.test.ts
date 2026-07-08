import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

type HttpMethod = "get" | "post" | "put";

interface RouteContract {
  readonly path: string;
  readonly methods: readonly HttpMethod[];
}

const publicCoreRouteContracts: readonly RouteContract[] = [
  { path: "/health", methods: ["get"] },
  { path: "/metrics", methods: ["get"] },
  { path: "/events", methods: ["get"] },
  { path: "/api/runs/latest", methods: ["get"] },
  { path: "/api/run-index", methods: ["get"] },
  { path: "/api/runs", methods: ["get"] },
  { path: "/api/health", methods: ["get"] },
  { path: "/api/validation-dashboard", methods: ["get"] },
  { path: "/api/topology/{runId}", methods: ["get"] },
  { path: "/api/narrative/{runId}", methods: ["get"] },
  { path: "/api/failures", methods: ["get"] },
  { path: "/api/impact", methods: ["get"] },
  { path: "/api/triage", methods: ["get"] },
  { path: "/api/triage/export", methods: ["post"] },
  { path: "/api/triage/issue-packet", methods: ["get"] },
  { path: "/api/traces/{traceId}", methods: ["get"] },
  { path: "/api/policies", methods: ["get", "put"] },
  { path: "/api/policy/simulate", methods: ["post"] },
  { path: "/api/integrations", methods: ["get"] },
  { path: "/api/integrations/verify", methods: ["post"] },
  { path: "/api/visibility/import/http", methods: ["post"] },
  { path: "/api/visibility/import/browser", methods: ["post"] },
  { path: "/api/story", methods: ["get"] },
  { path: "/api/story/reset", methods: ["post"] },
  { path: "/api/replay", methods: ["get", "post"] },
  { path: "/api/evidence", methods: ["get"] },
  { path: "/api/runs/{runId}/evidence", methods: ["get"] },
  { path: "/api/reports/export", methods: ["get"] },
  { path: "/api/bundle/export", methods: ["post"] },
  { path: "/api/bundle", methods: ["get"] },
  { path: "/api/bundles/{runId}/files/{relativePath}", methods: ["get"] },
  { path: "/api/reports", methods: ["get"] },
  { path: "/api/reports/{runId}/files/{fileName}", methods: ["get"] },
  { path: "/api/reports/{runId}/artifacts/{artifactId}", methods: ["get"] },
  { path: "/api/reports/{runId}", methods: ["get"] },
  { path: "/api/events/ingest", methods: ["post"] },
  { path: "/api/sidecar/v1/tool-calls", methods: ["post"] }
];

const dynamicCoreRouteTemplates = new Map<string, string>([
  ["/api/topology/", "/api/topology/{runId}"],
  ["/api/narrative/", "/api/narrative/{runId}"],
  ["/api/traces/", "/api/traces/{traceId}"],
  ["/api/bundles/", "/api/bundles/{runId}/files/{relativePath}"],
  ["/api/reports/", "/api/reports/{runId}"]
]);

describe("Core, UI, and OpenAPI path drift", () => {
  it("documents every proof-related public Core API route in OpenAPI", async () => {
    const serverSource = await readProjectFile("packages/core/src/server.ts");
    const openApi = parseOpenApiPaths(await readProjectFile("docs/api/openapi.yaml"));
    const extractedCoreRoutes = extractCorePublicPathTemplates(serverSource);

    expect([...extractedCoreRoutes].sort()).toEqual(publicCoreRouteContracts.map((route) => route.path).sort());

    const missingPaths = publicCoreRouteContracts.map((route) => route.path).filter((routePath) => !openApi.has(routePath));
    const missingMethods = missingOpenApiMethods(publicCoreRouteContracts, openApi);

    expect({ missingPaths, missingMethods }).toEqual({ missingPaths: [], missingMethods: [] });
  });

  it("documents every UI-consumed Core API route and method in OpenAPI", async () => {
    const uiSource = await readProjectFile("packages/ui/src/lib/api.ts");
    const openApi = parseOpenApiPaths(await readProjectFile("docs/api/openapi.yaml"));
    const uiRoutes = extractUiApiClientRoutes(uiSource);
    const missingMethods = missingOpenApiMethods(uiRoutes, openApi);

    expect({ uiRoutes, missingMethods }).toMatchObject({ missingMethods: [] });
  });

  it("does not document stale public Core API paths", async () => {
    const openApi = parseOpenApiPaths(await readProjectFile("docs/api/openapi.yaml"));
    const corePaths = new Set(publicCoreRouteContracts.map((route) => route.path));
    const stalePaths = [...openApi.keys()].filter((routePath) => routePath.startsWith("/") && !corePaths.has(routePath));

    expect(stalePaths).toEqual([]);
  });

  it("keeps key proof endpoint examples schema-valid and secret-free", async () => {
    const openApiSource = await readProjectFile("docs/api/openapi.yaml");
    const examples = parseComponentExamples(openApiSource);
    const exampleReferences = parseExampleReferences(openApiSource);
    const schemaRequiredFields = parseSchemaRequiredFields(openApiSource);

    const requiredEndpointExampleReferences = [
      { path: "/api/integrations", example: "IntegrationsSuccess" },
      { path: "/api/integrations/verify", example: "IntegrationVerifyRequest" },
      { path: "/api/integrations/verify", example: "IntegrationVerifySuccess" },
      { path: "/api/integrations/verify", example: "UnknownRouteError" },
      { path: "/api/visibility/import/http", example: "HttpImportRequest" },
      { path: "/api/visibility/import/http", example: "HttpImportAccepted" },
      { path: "/api/visibility/import/http", example: "MalformedJsonError" },
      { path: "/api/visibility/import/browser", example: "BrowserImportRequest" },
      { path: "/api/visibility/import/browser", example: "BrowserImportAccepted" },
      { path: "/api/replay", example: "ReplaySuccess" },
      { path: "/api/replay", example: "ReplayBlockedRequest" },
      { path: "/api/replay", example: "ReplayBlocked" },
      { path: "/api/validation-dashboard", example: "ValidationDashboardSuccess" },
      { path: "/api/reports", example: "ReportsSuccess" },
      { path: "/api/reports/export", example: "ReportExportSuccess" },
      { path: "/api/bundle", example: "BundleSuccess" },
      { path: "/api/bundle/export", example: "BundleExportRequest" },
      { path: "/api/bundle/export", example: "BundleExportSuccess" },
      { path: "/api/sidecar/v1/tool-calls", example: "SidecarToolCallRequest" },
      { path: "/api/sidecar/v1/tool-calls", example: "SidecarToolCallSuccess" },
      { path: "/api/sidecar/v1/tool-calls", example: "SidecarProtocolMismatch" }
    ];

    for (const { path: routePath, example } of requiredEndpointExampleReferences) {
      expect(exampleReferences.get(routePath), `${routePath} references ${example}`).toContain(example);
      expect(examples.has(example), `${example} is defined`).toBe(true);
    }

    const schemaExamples: Record<string, string> = {
      IntegrationsSuccess: "IntegrationsPayload",
      IntegrationVerifyRequest: "IntegrationVerificationRequest",
      IntegrationVerifySuccess: "IntegrationVerificationReceipt",
      UnknownRouteError: "ErrorResponse",
      MalformedJsonError: "ErrorResponse",
      ReplaySuccess: "ReplayPayload",
      ReplayBlocked: "ErrorResponse",
      ReportsSuccess: "ReportsPayload",
      ReportExportSuccess: "ReportExportResponse",
      BundleSuccess: "BundlePayload",
      BundleExportSuccess: "BundleExportResponse",
      ValidationDashboardSuccess: "ValidationDashboardPayload",
      SidecarProtocolMismatch: "ErrorResponse"
    };
    for (const [exampleName, schemaName] of Object.entries(schemaExamples)) {
      assertExampleSatisfiesRequiredFields(exampleName, examples.get(exampleName), schemaName, schemaRequiredFields);
    }

    const committedProofDocs = [openApiSource, await readProjectFile("README.md")].join("\n");
    const forbiddenPattern = new RegExp(
      [
        "Bearer\\s+[A-Za-z0-9._~+/=-]{12,}",
        "sk-[A-Za-z0-9]{20,}",
        ["BEGIN", "PRIVATE", "KEY"].join(" "),
        "api[_-]?key\\s*[:=]\\s*[A-Za-z0-9._~+/=-]{12,}",
        "token\\s*[:=]\\s*[A-Za-z0-9._~+/=-]{12,}",
        ["Ignore", "previous", "instructions"].join(" "),
        ["reveal", "the", "system", "prompt"].join(" ")
      ].join("|"),
      "i"
    );
    expect(committedProofDocs).not.toMatch(forbiddenPattern);
  });
});

async function readProjectFile(relativePath: string): Promise<string> {
  return await readFile(path.join(process.cwd(), "../..", relativePath), "utf8");
}

function parseOpenApiPaths(source: string): Map<string, Set<HttpMethod>> {
  const paths = new Map<string, Set<HttpMethod>>();
  const lines = source.split("\n");
  let inPaths = false;
  let currentPath: string | undefined;

  for (const line of lines) {
    if (line === "paths:") {
      inPaths = true;
      continue;
    }
    if (inPaths && /^[a-z]/.test(line) && line !== "paths:") {
      break;
    }
    const pathMatch = /^ {2}(\/[^:]+):$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1] ?? "";
      paths.set(currentPath, new Set());
      continue;
    }
    const methodMatch = /^ {4}(get|post|put):$/.exec(line);
    if (currentPath && methodMatch) {
      paths.get(currentPath)?.add(methodMatch[1] as HttpMethod);
    }
  }

  return paths;
}

function extractCorePublicPathTemplates(source: string): Set<string> {
  const paths = new Set<string>();
  for (const match of source.matchAll(/url\.pathname === "([^"]+)"/g)) {
    const routePath = match[1];
    if (routePath) {
      paths.add(routePath);
    }
  }
  if (source.includes("url.pathname === `/api/runs/${runId}/evidence`")) {
    paths.add("/api/runs/{runId}/evidence");
  }
  for (const [prefix, template] of dynamicCoreRouteTemplates) {
    if (source.includes(`url.pathname.startsWith("${prefix}")`)) {
      paths.add(template);
    }
  }
  if (source.includes('url.pathname.startsWith("/api/reports/") && url.pathname.includes("/files/")')) {
    paths.add("/api/reports/{runId}/files/{fileName}");
  }
  if (source.includes('url.pathname.startsWith("/api/reports/") && url.pathname.includes("/artifacts/")')) {
    paths.add("/api/reports/{runId}/artifacts/{artifactId}");
  }
  return paths;
}

function extractUiApiClientRoutes(source: string): readonly RouteContract[] {
  const routes = new Map<string, Set<HttpMethod>>();
  for (const match of source.matchAll(/fetchJson(?:AllowingStatus)?<[^>]+>\((`[^`]+`|"[^"]+")([\s\S]*?)\);/g)) {
    const routePath = normalizeUiPathExpression(match[1] ?? '""');
    const callOptions = match[2] ?? "";
    const method = /method:\s*"POST"/.test(callOptions) ? "post" : /method:\s*"PUT"/.test(callOptions) ? "put" : "get";
    addRoute(routes, routePath, method);
  }
  if (source.includes("new EventSource(`${CORE_API_BASE}/events`)")) {
    addRoute(routes, "/events", "get");
  }
  return [...routes.entries()]
    .map(([routePath, methods]) => ({ path: routePath, methods: [...methods].sort() as HttpMethod[] }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeUiPathExpression(expression: string): string {
  if (expression.startsWith('"')) {
    return JSON.parse(expression) as string;
  }
  return expression
    .slice(1, -1)
    .replace(/\$\{encodeURIComponent\(traceId\)\}/g, "{traceId}")
    .replace(/\$\{encodeURIComponent\(runId\)\}/g, "{runId}");
}

function addRoute(routes: Map<string, Set<HttpMethod>>, routePath: string, method: HttpMethod): void {
  const existing = routes.get(routePath) ?? new Set<HttpMethod>();
  existing.add(method);
  routes.set(routePath, existing);
}

function missingOpenApiMethods(
  routeContracts: readonly RouteContract[],
  openApi: Map<string, Set<HttpMethod>>
): Array<{ readonly path: string; readonly method: HttpMethod }> {
  return routeContracts.flatMap((route) =>
    route.methods
      .filter((method) => !openApi.get(route.path)?.has(method))
      .map((method) => ({
        path: route.path,
        method
      }))
  );
}

function parseComponentExamples(source: string): Map<string, unknown> {
  const examples = new Map<string, unknown>();
  const lines = source.split("\n");
  let inExamples = false;
  let currentExample: string | undefined;
  let pendingJson: string[] | undefined;
  let pendingBraceBalance = 0;

  for (const line of lines) {
    if (pendingJson) {
      pendingJson.push(line.trim());
      pendingBraceBalance += countJsonBraces(line);
      if (pendingBraceBalance === 0 && currentExample) {
        examples.set(currentExample, JSON.parse(pendingJson.join("\n")) as unknown);
        pendingJson = undefined;
      }
      continue;
    }
    if (line === "  examples:") {
      inExamples = true;
      continue;
    }
    if (inExamples && /^ {2}[a-zA-Z]/.test(line) && line !== "  examples:") {
      break;
    }
    if (!inExamples) continue;
    const exampleMatch = /^ {4}([A-Za-z0-9]+):$/.exec(line);
    if (exampleMatch) {
      currentExample = exampleMatch[1];
      continue;
    }
    const valueMatch = /^ {6}value: (.+)$/.exec(line);
    if (currentExample && valueMatch) {
      examples.set(currentExample, JSON.parse(valueMatch[1] ?? "null") as unknown);
      continue;
    }
    if (currentExample && /^ {6}value:$/.test(line)) {
      pendingJson = [];
      pendingBraceBalance = 0;
    }
  }

  return examples;
}

function countJsonBraces(line: string): number {
  return [...line].reduce((balance, character) => {
    if (character === "{") return balance + 1;
    if (character === "}") return balance - 1;
    return balance;
  }, 0);
}

function parseExampleReferences(source: string): Map<string, string[]> {
  const references = new Map<string, string[]>();
  const lines = source.split("\n");
  let inPaths = false;
  let currentPath: string | undefined;

  for (const line of lines) {
    if (line === "paths:") {
      inPaths = true;
      continue;
    }
    if (inPaths && line === "components:") {
      break;
    }
    if (!inPaths) continue;
    const pathMatch = /^ {2}(\/[^:]+):$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1] ?? "";
      references.set(currentPath, references.get(currentPath) ?? []);
      continue;
    }
    const refMatch = /^ {16,18}\$ref: "#\/components\/examples\/([A-Za-z0-9]+)"$/.exec(line);
    if (currentPath && refMatch) {
      const exampleName = refMatch[1] ?? "";
      references.get(currentPath)?.push(exampleName);
    }
  }

  return references;
}

function parseSchemaRequiredFields(source: string): Map<string, string[]> {
  const requiredFields = new Map<string, string[]>();
  const lines = source.split("\n");
  let inSchemas = false;
  let currentSchema: string | undefined;
  let currentRequiredSchema: string | undefined;

  for (const line of lines) {
    if (line === "  schemas:") {
      inSchemas = true;
      continue;
    }
    if (inSchemas && line === "  examples:") {
      break;
    }
    if (!inSchemas) continue;
    const schemaMatch = /^ {4}([A-Za-z0-9]+):$/.exec(line);
    if (schemaMatch) {
      currentSchema = schemaMatch[1];
      currentRequiredSchema = undefined;
      continue;
    }
    if (/^ {6}[a-zA-Z]/.test(line) && !/^ {6}required:/.test(line)) {
      currentRequiredSchema = undefined;
    }
    const requiredMatch = /^ {6}required: \[(.*)]$/.exec(line);
    if (currentSchema && requiredMatch) {
      requiredFields.set(
        currentSchema,
        (requiredMatch[1] ?? "")
          .split(",")
          .map((field) => field.trim())
          .filter(Boolean)
      );
      currentRequiredSchema = undefined;
      continue;
    }
    if (currentSchema && /^ {6}required:$/.test(line)) {
      requiredFields.set(currentSchema, []);
      currentRequiredSchema = currentSchema;
      continue;
    }
    const requiredItemMatch = /^ {8}- ([A-Za-z0-9]+)$/.exec(line);
    if (currentRequiredSchema && requiredItemMatch) {
      requiredFields.get(currentRequiredSchema)?.push(requiredItemMatch[1] ?? "");
    }
  }

  return requiredFields;
}

function assertExampleSatisfiesRequiredFields(
  exampleName: string,
  example: unknown,
  schemaName: string,
  schemaRequiredFields: Map<string, string[]>
): void {
  expect(example, `${exampleName} example object`).toEqual(expect.any(Object));
  expect(Array.isArray(example), `${exampleName} is not an array`).toBe(false);
  const objectExample = example as Record<string, unknown>;
  const missingRequiredFields = (schemaRequiredFields.get(schemaName) ?? []).filter((field) => !(field in objectExample));
  expect({ exampleName, schemaName, missingRequiredFields }).toMatchObject({ missingRequiredFields: [] });
}
