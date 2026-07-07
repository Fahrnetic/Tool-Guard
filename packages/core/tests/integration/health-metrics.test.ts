import { afterEach, describe, expect, it } from "vitest";
import { createCoreApiServer } from "../../src/index.js";

describe("Core API integration", () => {
  const handles: Array<ReturnType<typeof createCoreApiServer>> = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
  });

  it("serves health and metrics on loopback", async () => {
    const handle = createCoreApiServer({ port: 0, seedDirectRun: false });
    handles.push(handle);
    await handle.ready;
    const address = handle.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    const metrics = await fetch(`http://127.0.0.1:${address.port}/metrics`);

    expect(health.ok).toBe(true);
    expect(await metrics.text()).toContain("toolguard_events_total");
  });
});
