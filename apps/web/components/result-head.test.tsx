import type { DiagnosticLevel } from "@agentify/scanner-contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResultHead } from "./result-head";

const head = (
  fields: Partial<{ coverage: number; level: DiagnosticLevel; score: number | null }> = {},
) =>
  renderToStaticMarkup(
    <ResultHead
      coverage={fields.coverage ?? 0.94}
      host="shop.example"
      level={fields.level ?? "readable"}
      line="Private report"
      score={fields.score === undefined ? 46 : fields.score}
    />,
  );

describe("the head of a result", () => {
  it("marks a result read at under 70% coverage, or an incomplete one, provisional, and no other", () => {
    expect(head({ coverage: 0.69 })).toContain("Provisional diagnostic");
    expect(head({ level: "incomplete" })).toContain("Provisional diagnostic");
    expect(head({ coverage: 0.7 })).not.toContain("Provisional");
    expect(head({ coverage: 0.7 })).toContain("Diagnostic level");
  });

  it("says what callable-ready does not mean wherever that level is drawn", () => {
    expect(head({ level: "callable_ready", score: 63 })).toContain(
      "Agentify did not invoke tools or verify authenticated actions.",
    );
    expect(head()).not.toContain("did not invoke tools");
  });

  it("says a result without a score has none, and draws no scale for one", () => {
    const unscored = head({ score: null, coverage: 0.25, level: "incomplete" });

    expect(unscored).toContain("No score");
    expect(unscored).not.toContain('role="meter"');
    expect(head()).toContain('aria-valuenow="46"');
  });

  it("says the level is not a certification", () => {
    expect(head()).toContain("not a certification");
  });
});
