import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCoreApiServer } from "@toolplane/core";
import { runToolplaneCli } from "../src/run.js";

async function makeTempRoot(prefix = "toolguard-cli-"): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPidFile(filePath: string, timeoutMs = 1_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = Number((await readFile(filePath, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) {
        return value;
      }
    } catch {
      // Keep polling until the child fixture writes its pid.
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for pid file ${filePath}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeGrandchildFixture(root: string, fileName: string): Promise<string> {
  const script = path.join(root, fileName);
  await writeFile(
    script,
    [
      "import { spawn } from 'node:child_process';",
      "const pidFile = process.argv[2];",
      "const grandchild = spawn(process.execPath, [",
      "  '-e',",
      "  `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`",
      "], { stdio: 'ignore' });",
      "grandchild.unref();",
      "setInterval(() => {}, 1000);"
    ].join("\n"),
    "utf8"
  );
  return script;
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

  it("terminates a spawned grandchild process on timeout", async () => {
    const root = await makeTempRoot();
    const pidFile = path.join(root, "grandchild.pid");
    const script = await writeGrandchildFixture(root, "grandchild-timeout.mjs");

    const pending = runToolplaneCli(["run", "--timeout-ms", "500", "--", process.execPath, script, pidFile]);
    const grandchildPid = await readPidFile(pidFile);
    const result = await pending;
    await delay(350);

    try {
      expect(result.exitCode).toBe(124);
      expect(result.process?.timedOut).toBe(true);
      expect(processExists(grandchildPid)).toBe(false);
    } finally {
      if (processExists(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
    }
  });

  it("terminates a spawned grandchild process on cancellation", async () => {
    const root = await makeTempRoot();
    const pidFile = path.join(root, "grandchild-cancel.pid");
    const script = await writeGrandchildFixture(root, "grandchild-cancel.mjs");
    const controller = new AbortController();

    const pending = runToolplaneCli(
      ["run", "--timeout-ms", "5000", "--", process.execPath, script, pidFile],
      { signal: controller.signal }
    );
    const grandchildPid = await readPidFile(pidFile);
    controller.abort();
    const result = await pending;
    await delay(350);

    try {
      expect(result.exitCode).toBe(130);
      expect(result.process?.cancelled).toBe(true);
      expect(processExists(grandchildPid)).toBe(false);
    } finally {
      if (processExists(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
    }
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

  it("blocks high-risk non-rm shell, filesystem, redirection, and git patterns outside fixture-only mode", async () => {
    const root = await makeTempRoot();
    const victim = path.join(root, "victim.txt");
    await writeFile(victim, "still here", "utf8");

    const cases: readonly (readonly string[])[] = [
      ["sh", "-c", `printf overwritten > ${victim}`],
      ["sh", "-c", `mv ${victim} ${path.join(root, "moved.txt")}`],
      ["sh", "-c", `cp -f ${path.join(root, "source.txt")} ${victim}`],
      ["sh", "-c", `cp -R ${path.join(root, "source-dir")} ${path.join(root, "dest-dir")}`],
      ["sh", "-c", `find ${root} -type f -delete`],
      ["truncate", "-s", "0", victim],
      ["git", "reset", "--hard"],
      ["git", "clean", "-fd"],
      ["git", "push", "--force", "origin", "master"]
    ];

    for (const command of cases) {
      const blocked = await runToolplaneCli(["run", "--cwd", root, "--", ...command]);
      expect(blocked.exitCode).toBe(2);
      expect(blocked.process).toBeUndefined();
      expect(blocked.failureCard?.failureType).toBe("destructive_action_blocked");
      expect(await readFile(victim, "utf8")).toBe("still here");
    }

    const fixtureOnly = await runToolplaneCli(["run", "--fixture-only", "--cwd", root, "--", "sh", "-c", `printf overwritten > ${victim}`]);

    expect(fixtureOnly.exitCode).toBe(0);
    expect(fixtureOnly.result?.safeSummary).toContain("fixture-only");
    expect(await readFile(victim, "utf8")).toBe("still here");
  });

  it("allows shell move and copy destructive simulations in fixture-only mode", async () => {
    const root = await makeTempRoot();
    const victim = path.join(root, "victim.txt");
    const source = path.join(root, "source.txt");
    await writeFile(victim, "still here", "utf8");
    await writeFile(source, "replacement", "utf8");

    const simulatedMove = await runToolplaneCli([
      "run",
      "--fixture-only",
      "--cwd",
      root,
      "--",
      "sh",
      "-c",
      `mv ${victim} ${path.join(root, "moved.txt")}`
    ]);
    const simulatedCopy = await runToolplaneCli([
      "run",
      "--fixture-only",
      "--cwd",
      root,
      "--",
      "sh",
      "-c",
      `cp -f ${source} ${victim}`
    ]);

    expect(simulatedMove.exitCode).toBe(0);
    expect(simulatedMove.result?.safeSummary).toContain("fixture-only");
    expect(simulatedCopy.exitCode).toBe(0);
    expect(simulatedCopy.result?.safeSummary).toContain("fixture-only");
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
      await writeFile(script, "const key = ['to', 'ken'].join('') + '='; console.log(key + 'a'.repeat(36))\n", "utf8");

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
      expect(eventTypes).toContain("output.sanitized");
    } finally {
      await handle.close();
    }
  });

  it("emits output.sanitized events when CLI stream redaction occurs", async () => {
    const root = await makeTempRoot();
    const script = path.join(root, "secret.mjs");
    await writeFile(
      script,
      [
        "const key = ['to', 'ken'].join('') + '=';",
        "const scheme = ['Be', 'arer'].join('');",
        "console.log(key + 'a'.repeat(36));",
        "console.error(scheme + ' ' + 'b'.repeat(32));"
      ].join("\n"),
      "utf8"
    );

    const result = await runToolplaneCli(["run", "--evidence-root", root, "--", process.execPath, script]);

    expect(result.exitCode).toBe(0);
    expect(result.process?.stdout).toContain("[REDACTED:");
    expect(result.process?.stderr).toContain("[REDACTED:");
    const events = (await readFile(result.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const sanitizedEvents = events.filter((event) => event.type === "output.sanitized");
    expect(sanitizedEvents.length).toBeGreaterThanOrEqual(1);
    expect(sanitizedEvents[0].data.reason).toBe("secret_redaction");
  });
});
