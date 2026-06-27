#!/usr/bin/env node
import { runToolplaneCli } from "../run.js";

try {
  const executableName = process.argv[1]?.includes("toolguard") ? "toolguard" : "toolplane";
  const result = await runToolplaneCli(process.argv.slice(2), {
    executableName,
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk)
  });
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
