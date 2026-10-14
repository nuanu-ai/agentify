/**
 * One search index serves every channel and no Caddy fills it, so it names
 * what a deployment decides in words rather than as a template a reader would
 * see stripped to nothing, and it holds nothing a channel may not show.
 */

import { describe, expect, it } from "vitest";
import { searchIndex } from "./search.server.js";

const index = JSON.stringify(await searchIndex());

describe("the search index", () => {
  it("names the scanner's user agent and contacts in words", () => {
    expect(index).toContain("agentify-scanner/1.0 (+this site/scanner)");
    expect(index).toContain("Operator: the operator.");
    expect(index).not.toContain("<!--{{");
    expect(index).not.toContain("(+/scanner)");
  });

  it("holds no part a channel keeps off its pages", () => {
    expect(index).not.toContain("The final legal identity is not published yet.");
  });
});
