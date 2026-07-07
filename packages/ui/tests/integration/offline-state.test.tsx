import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Overview } from "../../src/screens/Overview.js";

describe("UI integration offline state", () => {
  it("renders Core health recovery guidance", () => {
    const html = renderToStaticMarkup(<Overview status="error" error="Core API /api/health returned HTTP 503" />);

    expect(html).toContain("Core API /api/health returned HTTP 503");
  });
});
