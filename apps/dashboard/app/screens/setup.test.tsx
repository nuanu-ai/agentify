// @vitest-environment jsdom

/** The merchant creation screen, drawn from the view the server hands it. */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/ui/surface";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { DRAWN_FOR } from "../../src/drawn-for.js";
import { formTo, readable } from "../../src/testing/html.js";
import type { Chrome, Gated } from "../answer.js";
import { MerchantScreen } from "./setup.js";

const WHO = "owner@example.com";

const chrome: Chrome = {
  base: "/dashboard",
  surface: {
    attribute: SURFACE_MARKER_ATTRIBUTE,
    mode: "sandbox",
    words: SURFACE_WORDS.sandbox,
  },
};

/** Inside the gate, so the merchant action carries the signed-in address. */
const gatedPage = (screen: () => ReactElement, gated: Gated = { who: WHO }): ReactElement => {
  const Stub = createRoutesStub([
    { id: "routes/gate", path: "/", children: [{ path: "page", Component: screen }] },
  ]);
  return (
    <Stub initialEntries={["/page"]} hydrationData={{ loaderData: { "routes/gate": gated } }} />
  );
};

const served = (screen: () => ReactElement, gated: Gated = { who: WHO }): string =>
  renderToString(gatedPage(screen, gated));

/** Read the merchant action form and its destination. */
describe("opening a seller dashboard", () => {
  it("names who is signed in, and makes nothing until the press, which carries that address", () => {
    const html = served(() => <MerchantScreen chrome={chrome} view={{ unavailable: false }} />);

    // On the card, not only in the header, which hides the address on a phone.
    expect(readable(/<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "")).toContain(WHO);
    expect(formTo(html, "post", "/merchant")?.fields.get(DRAWN_FOR)).toBe(WHO);
    expect(html).not.toContain('class="problem"');
  });

  it("says a press that made nothing failed on our side, and offers the press again", () => {
    const html = served(() => <MerchantScreen chrome={chrome} view={{ unavailable: true }} />);

    expect(readable(/<p class="problem">[\s\S]*?<\/p>/.exec(html)?.[0] ?? "")).toMatch(
      /fault on our side/,
    );
    expect(formTo(html, "post", "/merchant")?.fields.get(DRAWN_FOR)).toBe(WHO);
  });
});

describe("the operator's workspace link on the merchant screen", () => {
  it("is drawn only when the gate identifies an operator", () => {
    const screen = () => <MerchantScreen chrome={chrome} view={{ unavailable: false }} />;
    const withAccess = served(screen, { who: WHO, operator: true });
    const withoutAccess = served(screen);
    const doors = /<nav aria-label="Docs and dashboard"[^>]*>([\s\S]*?)<\/nav>/.exec(
      withAccess,
    )?.[1];

    expect(doors).toMatch(/<a [^>]*href="[^"]*\/admin"[^>]*>Admin<\/a>/);
    expect(withoutAccess).not.toMatch(/href="[^"]*\/admin\b/);
    expect(readable(withoutAccess)).not.toMatch(/\bAdmin\b/);
  });
});
