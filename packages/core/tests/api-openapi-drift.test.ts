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
    const schemas = parseComponentSchemas(openApiSource);
    const exampleSchemas = parseExampleSchemas(openApiSource);

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

    for (const [exampleName, schemaReference] of exampleSchemas) {
      const example = examples.get(exampleName);
      expect(example, `${exampleName} example is defined`).not.toBeUndefined();
      const errors = validateOpenApiExample(example, schemaReference, schemas);
      expect({ exampleName, schemaReference, errors }).toEqual({ exampleName, schemaReference, errors: [] });
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

interface OpenApiSchema {
  readonly ref?: string;
  readonly type?: string;
  readonly format?: string;
  readonly enum?: readonly unknown[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, OpenApiSchema>>;
  readonly items?: OpenApiSchema;
  readonly additionalProperties?: boolean | OpenApiSchema;
}

function parseComponentSchemas(source: string): Map<string, OpenApiSchema> {
  const schemas = new Map<string, OpenApiSchema>();
  const lines = source.split("\n");
  let inSchemas = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
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
      const schemaName = schemaMatch[1] ?? "";
      const parsed = parseOpenApiSchema(lines, index + 1, 6);
      schemas.set(schemaName, parsed.schema);
      index = parsed.nextIndex - 1;
    }
  }

  return schemas;
}

function parseExampleSchemas(source: string): Map<string, string> {
  const schemas = new Map<string, string>();
  const lines = source.split("\n");
  let inPaths = false;
  let currentSchema: string | undefined;

  for (const line of lines) {
    if (line === "paths:") {
      inPaths = true;
      continue;
    }
    if (inPaths && line === "components:") {
      break;
    }
    if (!inPaths) continue;
    if (/^ {2}\/[^:]+:$/.test(line) || /^ {4}(get|post|put):$/.test(line) || /^ {8}"?[0-9]{3}"?:$/.test(line)) {
      currentSchema = undefined;
    }
    const schemaRefMatch = /^ {14}\$ref: "#\/components\/schemas\/([A-Za-z0-9]+)"$/.exec(line);
    if (schemaRefMatch) {
      currentSchema = schemaRefMatch[1] ?? "";
      continue;
    }
    const inlineSchemaMatch = /^ {14}type: object$/.exec(line);
    if (inlineSchemaMatch) {
      currentSchema = undefined;
      continue;
    }
    const exampleRefMatch = /^ {16,18}\$ref: "#\/components\/examples\/([A-Za-z0-9]+)"$/.exec(line);
    if (exampleRefMatch && currentSchema) {
      schemas.set(exampleRefMatch[1] ?? "", currentSchema);
    }
  }

  return schemas;
}

function parseOpenApiSchema(
  lines: readonly string[],
  startIndex: number,
  indent: number
): { readonly schema: OpenApiSchema; readonly nextIndex: number } {
  const mutable: {
    ref?: string;
    type?: string;
    format?: string;
    enum?: unknown[];
    required?: string[];
    properties?: Record<string, OpenApiSchema>;
    items?: OpenApiSchema;
    additionalProperties?: boolean | OpenApiSchema;
  } = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const currentIndent = leadingSpaces(line);
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      index += 1;
      continue;
    }
    const trimmed = line.trim();

    if (trimmed.startsWith("$ref:")) {
      mutable.ref = unquote(trimmed.slice("$ref:".length).trim());
      index += 1;
      continue;
    }
    if (trimmed.startsWith("type:")) {
      mutable.type = trimmed.slice("type:".length).trim();
      index += 1;
      continue;
    }
    if (trimmed.startsWith("format:")) {
      mutable.format = trimmed.slice("format:".length).trim();
      index += 1;
      continue;
    }
    if (trimmed.startsWith("enum:")) {
      const value = trimmed.slice("enum:".length).trim();
      if (value.startsWith("[")) {
        mutable.enum = parseInlineArray(value);
        index += 1;
      } else {
        const parsed = parseYamlList(lines, index + 1, indent + 2);
        mutable.enum = parsed.values;
        index = parsed.nextIndex;
      }
      continue;
    }
    if (trimmed.startsWith("required:")) {
      const value = trimmed.slice("required:".length).trim();
      if (value.startsWith("[")) {
        mutable.required = parseInlineArray(value).filter((item): item is string => typeof item === "string");
        index += 1;
      } else {
        const parsed = parseYamlList(lines, index + 1, indent + 2);
        mutable.required = parsed.values.filter((item): item is string => typeof item === "string");
        index = parsed.nextIndex;
      }
      continue;
    }
    if (trimmed === "properties:") {
      const parsed = parseSchemaProperties(lines, index + 1, indent + 2);
      mutable.properties = parsed.properties;
      index = parsed.nextIndex;
      continue;
    }
    if (trimmed === "items:") {
      const parsed = parseOpenApiSchema(lines, index + 1, indent + 2);
      mutable.items = parsed.schema;
      index = parsed.nextIndex;
      continue;
    }
    if (trimmed.startsWith("additionalProperties:")) {
      const value = trimmed.slice("additionalProperties:".length).trim();
      if (value === "true" || value === "false") {
        mutable.additionalProperties = value === "true";
        index += 1;
      } else {
        const parsed = parseOpenApiSchema(lines, index + 1, indent + 2);
        mutable.additionalProperties = Object.keys(parsed.schema).length > 0 ? parsed.schema : true;
        index = parsed.nextIndex;
      }
      continue;
    }
    index += 1;
  }

  return { schema: mutable, nextIndex: index };
}

function parseSchemaProperties(
  lines: readonly string[],
  startIndex: number,
  indent: number
): { readonly properties: Record<string, OpenApiSchema>; readonly nextIndex: number } {
  const properties: Record<string, OpenApiSchema> = {};
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const currentIndent = leadingSpaces(line);
    if (currentIndent < indent) break;
    const propertyMatch = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):$`).exec(line);
    if (!propertyMatch) {
      index += 1;
      continue;
    }
    const parsed = parseOpenApiSchema(lines, index + 1, indent + 2);
    properties[propertyMatch[1] ?? ""] = parsed.schema;
    index = parsed.nextIndex;
  }
  return { properties, nextIndex: index };
}

function parseYamlList(
  lines: readonly string[],
  startIndex: number,
  indent: number
): { readonly values: unknown[]; readonly nextIndex: number } {
  const values: unknown[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const listMatch = new RegExp(`^ {${indent}}- (.+)$`).exec(line);
    if (!listMatch) break;
    values.push(parseScalar(listMatch[1] ?? ""));
    index += 1;
  }
  return { values, nextIndex: index };
}

function parseInlineArray(value: string): unknown[] {
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => parseScalar(item.trim()))
    .filter((item) => item !== "");
}

function parseScalar(value: string): unknown {
  const unquoted = unquote(value);
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function leadingSpaces(value: string): number {
  return value.length - value.trimStart().length;
}

function validateOpenApiExample(example: unknown, schemaReference: string, schemas: ReadonlyMap<string, OpenApiSchema>): string[] {
  return validateSchema(example, resolveSchema({ ref: `#/components/schemas/${schemaReference}` }, schemas), schemas, schemaReference);
}

function resolveSchema(schema: OpenApiSchema, schemas: ReadonlyMap<string, OpenApiSchema>): OpenApiSchema {
  if (!schema.ref) return schema;
  const schemaName = schema.ref.replace("#/components/schemas/", "");
  return schemas.get(schemaName) ?? {};
}

function validateSchema(value: unknown, schema: OpenApiSchema, schemas: ReadonlyMap<string, OpenApiSchema>, pathLabel: string): string[] {
  const resolved = resolveSchema(schema, schemas);
  const errors: string[] = [];

  if (resolved.enum && !resolved.enum.includes(value)) {
    errors.push(`${pathLabel} must be one of ${resolved.enum.join(", ")}`);
  }
  if (resolved.type) {
    const typeError = validateType(value, resolved.type, pathLabel);
    if (typeError) errors.push(typeError);
  }
  if (resolved.format === "date-time" && typeof value === "string" && Number.isNaN(Date.parse(value))) {
    errors.push(`${pathLabel} must be a date-time string`);
  }
  if (resolved.format === "uri" && typeof value === "string" && !URL.canParse(value)) {
    errors.push(`${pathLabel} must be a URI string`);
  }
  if (resolved.type === "array" && Array.isArray(value) && resolved.items) {
    value.forEach((item, index) => {
      errors.push(...validateSchema(item, resolved.items!, schemas, `${pathLabel}[${index}]`));
    });
  }
  if (resolved.type === "object" && isObjectRecord(value)) {
    for (const field of resolved.required ?? []) {
      if (!(field in value)) {
        errors.push(`${pathLabel}.${field} is required`);
      }
    }
    for (const [field, propertySchema] of Object.entries(resolved.properties ?? {})) {
      if (field in value) {
        errors.push(...validateSchema(value[field], propertySchema, schemas, `${pathLabel}.${field}`));
      }
    }
    if (resolved.additionalProperties === false) {
      const allowed = new Set(Object.keys(resolved.properties ?? {}));
      for (const field of Object.keys(value)) {
        if (!allowed.has(field)) {
          errors.push(`${pathLabel}.${field} is not allowed`);
        }
      }
    } else if (typeof resolved.additionalProperties === "object") {
      for (const [field, propertyValue] of Object.entries(value)) {
        if (!(field in (resolved.properties ?? {}))) {
          errors.push(...validateSchema(propertyValue, resolved.additionalProperties, schemas, `${pathLabel}.${field}`));
        }
      }
    }
  }
  return errors;
}

function validateType(value: unknown, type: string, pathLabel: string): string | undefined {
  if (type === "object") return isObjectRecord(value) ? undefined : `${pathLabel} must be an object`;
  if (type === "array") return Array.isArray(value) ? undefined : `${pathLabel} must be an array`;
  if (type === "string") return typeof value === "string" ? undefined : `${pathLabel} must be a string`;
  if (type === "number") return typeof value === "number" ? undefined : `${pathLabel} must be a number`;
  if (type === "integer") return Number.isInteger(value) ? undefined : `${pathLabel} must be an integer`;
  if (type === "boolean") return typeof value === "boolean" ? undefined : `${pathLabel} must be a boolean`;
  return undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
