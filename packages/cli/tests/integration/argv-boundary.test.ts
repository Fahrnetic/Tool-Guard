import { describe, expect, it } from "vitest";
import { parseToolplaneRunArgs } from "../../src/index.js";

describe("CLI integration boundary", () => {
  it("preserves command arguments after the run delimiter", () => {
    const parsed = parseToolplaneRunArgs(["run", "--", "node", "-e", "console.log('ok')"]);

    expect(parsed.command).toEqual(["node", "-e", "console.log('ok')"]);
  });
});
