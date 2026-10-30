// @vitest-environment jsdom

/** Client navigation is isolated from asynchronous server prerender contexts. */
import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/ui/surface";
import { cleanup, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { Chrome } from "../answer.js";
import { WooPage } from "./woocommerce.js";

afterEach(cleanup);
const SEEN_BY = { who: "owner@example.com" };

describe("a press's address reached inside the application", () => {
  // Back or Forward from a section the application drew returns to the
  // press's address without its answer, which React Router does not keep.
  it("leads to the shop screen rather than to a page saying the dashboard is broken", async () => {
    const chrome: Chrome = {
      base: "",
      surface: {
        attribute: SURFACE_MARKER_ATTRIBUTE,
        mode: "sandbox",
        words: SURFACE_WORDS.sandbox,
      },
    };
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        children: [
          {
            id: "routes/gate",
            children: [
              { path: "woocommerce/import", Component: () => <WooPage view={undefined} /> },
              { path: "woocommerce", Component: () => <p>The shop screen</p> },
            ],
          },
        ],
      },
    ]);

    const page = render(
      <Stub
        initialEntries={["/woocommerce/import"]}
        hydrationData={{ loaderData: { root: chrome, "routes/gate": { who: SEEN_BY.who } } }}
      />,
    );

    expect(await page.findByText("The shop screen")).toBeDefined();
  });
});
