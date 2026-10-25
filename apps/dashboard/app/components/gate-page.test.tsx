// @vitest-environment jsdom

/**
 * The pages in front of the dashboard, the sign-in among them, are where an
 * account is made, so whoever lands on one can read the terms and how their
 * data is handled from it, at any width.
 */

import { SURFACE_MARKER_ATTRIBUTE } from "@agentify/ui/surface";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { GatePage } from "./gate-page.js";

afterEach(cleanup);

const CHROME = {
  base: "/dashboard",
  surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode: "live", words: null },
} as const;

describe("a page in front of the dashboard", () => {
  it("leads from its foot to the terms, the privacy notice, the documentation and the page about selling", () => {
    const Stub = createRoutesStub([
      {
        path: "*",
        Component: () => (
          <GatePage chrome={CHROME} title="Sign in">
            <h1>Sign in</h1>
          </GatePage>
        ),
      },
    ]);
    render(<Stub initialEntries={["/sign-in"]} />);

    const footer = within(screen.getByRole("contentinfo"));
    for (const [name, href] of [
      ["Terms", "/terms"],
      ["Privacy", "/privacy"],
      ["Docs", "/docs/"],
      ["Sell to agents", "/agentic-shop"],
    ] as const) {
      expect(footer.getByRole("link", { name }).getAttribute("href"), name).toBe(href);
    }
  });
});
