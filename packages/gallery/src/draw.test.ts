import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { drawSurface } from "./draw.js";

describe("a server-drawn state in the script-free gallery frame", () => {
  it("shows large asynchronous Suspense content without running replacement scripts", async () => {
    const root = await mkdtemp(fileURLToPath(new URL("../.suspense-", import.meta.url)));
    try {
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await writeFile(join(root, "vite.config.ts"), "export default {};");
      await writeFile(
        join(root, "gallery.ts"),
        `
        import { createElement as h, Suspense } from "react";
        async function Detail() {
          await new Promise(resolve => setTimeout(resolve, 1));
          return h("p", null, "Product check complete");
        }
        async function Shop() {
          await new Promise(resolve => setTimeout(resolve, 1));
          return h("section", null, h("h1", null, "Your shop"),
            h(Suspense, { fallback: "Checking products" }, h(Detail)),
            h("aside", null, "x".repeat(20_000)));
        }
        export const gallery = {
          id: "shop", name: "Shop", lang: "en", states: [{
            id: "shop-checked", screen: "Products", address: "/products",
            when: "The check finishes.", cause: "The shop answers.",
            draw: () => h("main", null,
              h(Suspense, { fallback: "Loading your shop" }, h(Shop)))
          }]
        };
      `,
      );
      const drawn = await drawSurface({ root, module: "gallery.ts" });
      const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
        JSDOM: new (html: string) => { window: { document: Document; close(): void } };
      };
      const page = new JSDOM(drawn.states[0]?.html ?? "");
      const parsed = page.window.document;
      // jsdom runs no scripts, just as the gallery's sandbox forbids them.
      for (const node of parsed.querySelectorAll("[hidden], template, script")) node.remove();
      expect(parsed.querySelector("main h1")?.textContent).toBe("Your shop");
      expect(parsed.querySelector("main p")?.textContent).toBe("Product check complete");
      expect(parsed.body.textContent).not.toMatch(/Loading your shop|Checking products/);
      page.window.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
