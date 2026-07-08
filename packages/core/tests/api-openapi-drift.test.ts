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
