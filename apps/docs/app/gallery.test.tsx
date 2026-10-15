/**
 * The gallery's promise to whoever reviews the documentation there: every
 * page the documentation lists is shown, and every state is drawn without
 * failing. A page added to the contents without a state fails here.
 */

import { DOCS_PAGES, docsAddress } from "@agentify/ui/docs";
import { prerender } from "react-dom/static";
import { describe, expect, it } from "vitest";
import { gallery } from "./gallery.js";

describe("the documentation's gallery", () => {
  it("shows every page the documentation lists", () => {
    const shown = new Set(gallery.states.map((state) => state.address));

    expect(DOCS_PAGES.map((page) => docsAddress(page.path)).filter((at) => !shown.has(at))).toEqual(
      [],
    );
  });

  it.each(gallery.states.map((state) => [state.id, state] as const))(
    "draws %s whole, its heading included",
    async (_id, state) => {
      const failures: unknown[] = [];
      const { prelude } = await prerender(state.draw(), {
        onError: (failure) => void failures.push(failure),
      });
      const html = await new Response(prelude).text();

      expect(failures).toEqual([]);
      expect(html).toMatch(/<h1[^>]*>/);
      expect(html).not.toContain("<!--{{");
    },
  );
});
