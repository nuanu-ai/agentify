/**
 * A reader sees every diagram a page writes, drawn as the page now writes it:
 * the build reads each drawing by the key of its source and refuses one with
 * none, and `pnpm --filter @agentify/docs diagrams` draws what is missing.
 * These hold that the drawings committed beside the Markdown are exactly the
 * ones the pages need, so the image's build, which runs no browser, finds
 * every one.
 */

import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIAGRAMS, diagramKey, drawingOf } from "./diagrams.server.js";
import { diagramSources } from "./markdown.server.js";

const kept = readdirSync(DIAGRAMS)
  .filter((name) => name.endsWith(".svg"))
  .map((name) => name.replace(/\.svg$/, ""));

describe("the documentation's diagrams", () => {
  it("are drawn for every diagram a page writes, as the page writes it", async () => {
    const sources = await diagramSources();

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(kept, `draw it with pnpm --filter @agentify/docs diagrams:\n${source}`).toContain(
        diagramKey(source),
      );
      expect(drawingOf(source)).toMatch(/^<svg\b/);
    }
  });

  it("keep no drawing a page no longer writes", async () => {
    const wanted = new Set((await diagramSources()).map(diagramKey));

    expect(kept.filter((key) => !wanted.has(key))).toEqual([]);
  });

  it("refuse a diagram with no drawing, saying how to draw it", () => {
    expect(() => drawingOf("sequenceDiagram\n  A->>B: never drawn\n")).toThrow(
      /pnpm --filter @agentify\/docs diagrams/,
    );
  });
});
