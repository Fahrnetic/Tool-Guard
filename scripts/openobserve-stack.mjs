import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const command = process.argv[2] ?? "up";
const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);
const envPath = new URL(".tmp/openobserve.env", root);
const composePath = new URL("observability/openobserve/docker-compose.yml", root);
const existingEnv = readEnvFile(envPath);
const existingOpenObservePassword = existingEnv.OPENOBSERVE_ROOT_USER_PASSWORD;
const existingGrafanaPassword = existingEnv.GRAFANA_ADMIN_PASSWORD;
const email = process.env.OPENOBSERVE_ROOT_USER_EMAIL ?? existingEnv.OPENOBSERVE_ROOT_USER_EMAIL ?? "root@example.com";
const password =
  process.env.OPENOBSERVE_ROOT_USER_PASSWORD ??
  (isOpenObserveCompatibleCredential(existingOpenObservePassword) ? existingOpenObservePassword : generateStrongCredential());
const grafanaPassword =
  process.env.GRAFANA_ADMIN_PASSWORD ??
  (isStrongGeneratedCredential(existingGrafanaPassword) ? existingGrafanaPassword : generateStrongCredential());
const authHeader = `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;

mkdirSync(new URL(".tmp/", root), { recursive: true });
writeFileSync(
  envPath,
  [
    `OPENOBSERVE_ROOT_USER_EMAIL=${formatEnvValue(email)}`,
    `OPENOBSERVE_ROOT_USER_PASSWORD=${formatEnvValue(password)}`,
    `OPENOBSERVE_AUTH_HEADER=${formatEnvValue(authHeader)}`,
    `GRAFANA_ADMIN_PASSWORD=${formatEnvValue(grafanaPassword)}`
  ].join("\n") + "\n",
  "utf8"
);
chmodSync(envPath, 0o600);
ensureBindMountFilesReadable();

if (!["up", "down", "config"].includes(command)) {
  console.error(`Unknown observability stack command: ${command}`);
  process.exit(1);
}

const args =
  command === "up"
    ? ["compose", "--env-file", envPath.pathname, "-f", composePath.pathname, "up", "-d"]
    : ["compose", "--env-file", envPath.pathname, "-f", composePath.pathname, command];
const result = spawnSync("docker", args, { stdio: "inherit" });

if (result.error) {
  console.error(`Docker is required for observability:${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

function formatEnvValue(value) {
  const normalized = value.replaceAll("\n", "");
  if (/^[A-Za-z0-9_@./:-]+$/.test(normalized)) return normalized;
  return `'${normalized.replaceAll("'", "'\\''")}'`;
}

function generateStrongCredential() {
  return `Tg1!${randomBytes(24).toString("base64url")}`;
}

function isStrongGeneratedCredential(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 128 && /^[A-Za-z0-9!_-]+$/.test(value);
}

function isOpenObserveCompatibleCredential(value) {
  return isStrongGeneratedCredential(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value);
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator === -1) return [line, ""];
        return [line.slice(0, separator), parseEnvValue(line.slice(separator + 1))];
      })
  );
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("'\\''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  return value;
}

function ensureBindMountFilesReadable() {
  for (const path of [
    "observability/openobserve/otel-collector-config.yml",
    "observability/prometheus/prometheus.yml",
    "observability/prometheus/rules/toolguard.yml",
    "observability/loki/loki-config.yml",
    "observability/promtail/promtail-config.yml",
    "observability/grafana/provisioning",
    "observability/grafana/dashboards",
    "runs"
  ]) {
    makeReadable(join(rootPath, path));
  }
}

function makeReadable(path) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) {
      makeReadable(join(path, entry));
    }
    return;
  }
  chmodSync(path, 0o644);
}
