import { pathToFileURL } from "node:url";
import { startStoryModeFixtureServer } from "./story-serve.js";

function parsePort(argv: readonly string[]): number {
  const explicit = argv.indexOf("--port");
  const value = explicit >= 0 ? argv[explicit + 1] : process.env.TOOLGUARD_FIXTURE_PORT;
  const port = Number(value ?? 3662);
  if (!Number.isInteger(port) || port < 3662 || port > 3664) {
    throw new Error(`Fixture server port must be one of the approved demo fixture ports 3662-3664. Received: ${String(value ?? port)}`);
  }
  return port;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = parsePort(process.argv.slice(2));
  const fixture = startStoryModeFixtureServer(port);
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await fixture.close();
  };
  process.on("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });
  fixture.ready
    .then(async () => {
      console.log(`ToolGuard story fixture server listening on http://127.0.0.1:${port}`);
      await new Promise<void>(() => undefined);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
