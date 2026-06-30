import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReplayLab } from "../src/screens/ReplayLab.js";
import type { ReplayPayload } from "../src/lib/model.js";

const payload: ReplayPayload = {
  runId: "run_replay",
  generatedAt: "2026-06-30T00:00:00.000Z",
  replayCategories: [
    {
      category: "fixture replay",
      label: "Fixture replay",
      status: "safe",
      safe: true,
      executionMode: "execute",
      summary: "Deterministic fixture replay can execute safely."
    },
    {
      category: "loopback replay",
      label: "Loopback replay",
      status: "safe",
      safe: true,
      executionMode: "loopback",
      summary: "Verified loopback routes can replay against local endpoints."
    },
    {
      category: "real-command dry-run",
      label: "Real-command dry-run",
      status: "dry-run",
      safe: true,
      executionMode: "dry-run",
      summary: "Recorded real-world commands are previewed without execution."
    },
    {
      category: "not replayable",
      label: "Not replayable",
      status: "blocked",
      safe: false,
      executionMode: "blocked",
      summary: "Unsafe or unverifiable runs are explicitly not replayable."
    }
  ],
  replayableRuns: [
    {
      sourceRunId: "run_source",
      label: "Latest failed ToolGuard run",
      failureCount: 1,
      safe: true,
      fixtureOnly: true,
      category: "fixture replay"
    }
  ],
  fixtures: [
    {
      id: "fixture.wrong-cwd",
      label: "Wrong cwd failure reconstruction",
      status: "safe",
      safe: true,
      fixtureOnly: true,
      destructiveRisk: "none",
      category: "fixture replay",
      executionMode: "execute",
      description: "Replays the deterministic cwd mismatch failure with fresh correlation IDs."
    },
    {
      id: "http.loopback.identity",
      label: "Verified loopback route replay",
      status: "safe",
      safe: true,
      fixtureOnly: false,
      destructiveRisk: "none",
      category: "loopback replay",
      executionMode: "loopback",
      description: "Replays only against a verified local loopback endpoint."
    },
    {
      id: "real-world.git-status",
      label: "Recorded git status dry-run",
      status: "dry-run",
      safe: true,
      fixtureOnly: false,
      destructiveRisk: "low",
      category: "real-command dry-run",
      executionMode: "dry-run",
      description: "Shows the recorded command plan without executing it."
    },
    {
      id: "real-world.rm-rf",
      label: "Real-world destructive command",
      status: "blocked",
      safe: false,
      fixtureOnly: false,
      destructiveRisk: "high",
      category: "not replayable",
      executionMode: "blocked",
      description: "Blocked by policy. Replay Lab never executes destructive real-world commands."
    }
  ],
  latestReplayEvents: []
};

describe("ReplayLab", () => {
  it("visibly labels every replay recipe category without claiming unsafe execution", () => {
    const html = renderToStaticMarkup(<ReplayLab payload={payload} status="ready" />);

    expect(html).toContain("fixture replay");
    expect(html).toContain("loopback replay");
    expect(html).toContain("real-command dry-run");
    expect(html).toContain("not replayable");
    expect(html).toContain("Loopback replay");
    expect(html).toContain("Real-command dry-run");
    expect(html).toContain("Not replayable");
    expect(html).toContain("dry-run");
    expect(html).toContain("blocked");
    expect(html).toContain("Replay Lab never executes destructive real-world commands");
  });
});
