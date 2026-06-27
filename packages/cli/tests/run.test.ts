import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCoreApiServer } from "@toolplane/core";
import { runToolplaneCli } from "../src/run.js";

async function makeTempRoot(prefix = "toolguard-cli-"): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

describe("toolplane run process wrapper", () => {
  it("preserves argv boundaries after -- without shell interpretation", async () => {
    const root = await makeTempRoot();
    const script = path.join(root, "argv.mjs");
    await writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)))\n", "utf8");

    const result = await runToolplaneCli([
      "run",
      "--",
      process.execPath,
      script,
      "space value",
      "semi;colon",
      "$(not-expanded)",
      "pipe|value"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.process?.stdout).toContain('["space value","semi;colon","$(not-expanded)","pipe|value"]');
    expect(result.process?.stdout).not.toContain("not-expanded: command not found");
    expect(result.result?.safeSummary).toContain("completed successfully");
  });

  it("captures stdout, stderr, non-zero exit status, elapsed time, and evidence", async () => {
    const root = await makeTempRoot();
    const script = path.join(root, "fail.mjs");
    await writeFile(
      script,
      "console.log('visible stdout'); console.error('visible stderr'); process.exit(7)\n",
      "utf8"
    );

    const result = await runToolplaneCli(["run", "--evidence-root", root, "--", process.execPath, script]);

    expect(result.exitCode).toBe(7);
    expect(result.process).toMatchObject({
      command: process.execPath,
      exitCode: 7,
      timedOut: false
    });
    expect(result.process?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.process?.stdout).toContain("visible stdout");
    expect(result.process?.stderr).toContain("visible stderr");
    expect(result.failureCard?.failureType).toBe("non_zero_exit");

    const events = (await readFile(result.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toContain("tool.call.failed");
    expect(events.filter((event) => event.type === "evidence.artifact.created").length).toBeGreaterThanOrEqual(2);
  });

  it("enforces timeouts and terminates children safely", async () => {
    const root = await makeTempRoot();
    const script = path.join(root, "hang.mjs");
    await writeFile(script, "setInterval(() => console.log('tick'), 50)\n", "utf8");

    const result = await runToolplaneCli(["run", "--timeout-ms", "50", "--", process.execPath, script]);

    expect(result.exitCode).toBe(124);
    expect(result.process?.timedOut).toBe(true);
    expect(result.failureCard?.failureType).toBe("timeout");
  });

  it("handles cwd, env redaction, stdin, and output limits safely", async () => {
    const root = await makeTempRoot();
    const cwd = await makeTempRoot("toolguard-cli-cwd-");
    const script = path.join(root, "io.mjs");
    await writeFile(
      script,
      [
        "let input = '';",
        "process.stdin.on('data', (chunk) => input += chunk);",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({ cwd: process.cwd(), input, token: process.env.SECRET_TOKEN }));",
        "  console.error('E'.repeat(80));",
        "});"
      ].join("\n"),
      "utf8"
    );

    const result = await runToolplaneCli([
      "run",
      "--cwd",
      cwd,
      "--env",
      "SECRET_TOKEN=sk-test_abcdefghijklmnopqrstuvwxyz",
      "--stdin",
      "hello stdin",
      "--output-limit-bytes",
      "48",
      "--",
      process.execPath,
      script
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.process?.cwd).toBe(cwd);
    expect(result.process?.stdout).toContain("[truncated]");
    expect(result.process?.stderr).toContain("[truncated]");
    expect(JSON.stringify(result)).not.toContain("sk-test_abcdefghijklmnopqrstuvwxyz");
    expect(result.failureCard?.failureType).toBe("output_limit_exceeded");
  });

  it("supports safe git read commands", async () => {
    const result = await runToolplaneCli(["run", "--cwd", "/home/zfahrny/Projects/toolplane", "--", "git", "status", "--short"]);

    expect(result.exitCode).toBe(0);
    expect(result.process?.command).toBe("git");
    expect(result.failureCard).toBeUndefined();
    expect(result.eventsPath).toContain(result.runId);
  });

  it("blocks destructive commands unless fixture-only", async () => {
    const root = await makeTempRoot();
    const victim = path.join(root, "victim.txt");
    await writeFile(victim, "still here", "utf8");

    const blocked = await runToolplaneCli(["run", "--cwd", root, "--", "rm", "-f", victim]);

    expect(blocked.exitCode).toBe(2);
    expect(blocked.process).toBeUndefined();
    expect(blocked.failureCard?.failureType).toBe("destructive_action_blocked");
    expect(await readFile(victim, "utf8")).toBe("still here");

    const fixtureOnly = await runToolplaneCli(["run", "--fixture-only", "--cwd", root, "--", "rm", "-f", victim]);

    expect(fixtureOnly.exitCode).toBe(0);
    expect(fixtureOnly.result?.safeSummary).toContain("fixture-only");
    expect(await readFile(victim, "utf8")).toBe("still here");
  });

  it("treats toolguard alias argv equivalently", async () => {
    const root = await makeTempRoot();
    const script = path.join(root, "ok.mjs");
    await writeFile(script, "console.log('alias ok')\n", "utf8");

    const toolplane = await runToolplaneCli(["run", "--", process.execPath, script], { executableName: "toolplane" });
    const toolguard = await runToolplaneCli(["run", "--", process.execPath, script], { executableName: "toolguard" });

    expect(toolplane.exitCode).toBe(0);
    expect(toolguard.exitCode).toBe(0);
    expect(toolguard.process?.stdout).toContain(toolplane.process?.stdout.trim());
  });

  it("forwards CLI events to the local Core API when configured", async () => {
    const root = await makeTempRoot();
    const handle = createCoreApiServer({ port: 3666, evidenceRoot: root, seedDirectRun: false });
    await handle.ready;
    try {
      const script = path.join(root, "stream.mjs");
      await writeFile(script, "console.log('streamed')\n", "utf8");

      const result = await runToolplaneCli([
        "run",
        "--core-url",
        "http://127.0.0.1:3666",
        "--",
        process.execPath,
        script
      ]);

      expect(result.exitCode).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const eventTypes = handle.session.recorder.events.map((event) => event.type);
      expect(eventTypes).toContain("adapter.connected");
      expect(eventTypes).toContain("tool.call.started");
      expect(eventTypes).toContain("tool.call.completed");
    } finally {
      await handle.close();
    }
  });
});
