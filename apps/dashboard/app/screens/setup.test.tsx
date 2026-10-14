/**
 * A new merchant's setup screens, drawn as the server sends them from the
 * views and words the server half hands them. What the person pressed and
 * typed is the subject: a failed press is said and offered again, and a
 * refused name comes back to be corrected with the reason beside the box.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/core";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { DRAWN_FOR } from "../../src/drawn-for.js";
import { NAME_NEEDED, NAME_REFUSED, NAME_RULE } from "../../src/seller-name.js";
import { formTo, readable } from "../../src/testing/html.js";
import type { Chrome } from "../answer.js";
import { ChooseNameScreen, MerchantScreen } from "./setup.js";

const WHO = "owner@example.com";

const chrome: Chrome = {
  base: "/dashboard",
  surface: {
    attribute: SURFACE_MARKER_ATTRIBUTE,
    mode: "sandbox",
    words: SURFACE_WORDS.sandbox,
  },
};

/** Inside the gate, as the screens are, so a form that posts knows its address. */
const served = (screen: () => ReactElement): string => {
  const Stub = createRoutesStub([
    { id: "routes/gate", path: "/", children: [{ path: "page", Component: screen }] },
  ]);
  return renderToString(
    <Stub
      initialEntries={["/page"]}
      hydrationData={{ loaderData: { "routes/gate": { who: WHO } } }}
    />,
  );
};

/** The box and the line its description names, as a screen reader reads them together. */
const nameBox = (html: string) => {
  const input = /<input\b[^>]*name="seller_name"[^>]*>/.exec(html)?.[0] ?? "";
  const attribute = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(input)?.[1];
  const described = attribute("aria-describedby");
  const line =
    described === undefined
      ? undefined
      : readable(
          new RegExp(`<p[^>]*id="${described}"[^>]*>([\\s\\S]*?)</p>`).exec(html)?.[1] ?? "",
        );
  return { value: attribute("value"), invalid: attribute("aria-invalid"), line };
};

describe("opening a seller dashboard", () => {
  it("names who is signed in, and makes nothing until the press, which carries that address", () => {
    const html = served(() => <MerchantScreen chrome={chrome} view={{ unavailable: false }} />);

    expect(readable(html)).toContain(WHO);
    expect(formTo(html, "post", "/merchant")?.fields.get(DRAWN_FOR)).toBe(WHO);
    expect(html).not.toContain('class="problem"');
  });

  it("offers one way out, the header's", () => {
    const html = served(() => <MerchantScreen chrome={chrome} view={{ unavailable: false }} />);

    expect(html.match(/<form\b[^>]*action="[^"]*\/sign-out"/g)).toHaveLength(1);
  });

  it("says a press that made nothing failed on our side, and offers the press again", () => {
    const html = served(() => <MerchantScreen chrome={chrome} view={{ unavailable: true }} />);

    expect(readable(/<p class="problem">[\s\S]*?<\/p>/.exec(html)?.[0] ?? "")).toMatch(
      /not opened because of a fault on our side/,
    );
    expect(formTo(html, "post", "/merchant")?.fields.get(DRAWN_FOR)).toBe(WHO);
  });
});

describe("choosing the seller name", () => {
  it("says the rule under the box before anything is typed", () => {
    const html = served(() => (
      <ChooseNameScreen chrome={chrome} view={{ typed: "", rule: NAME_RULE }} />
    ));

    const box = nameBox(html);
    expect(box.value).toBe("");
    expect(box.invalid).toBeUndefined();
    expect(box.line).toBe(NAME_RULE);
    expect(readable(html).split(NAME_RULE)).toHaveLength(2);
  });

  it("gives a refused name back in the box, marked, with the refusal as what the box says", () => {
    const typed = 'Кириллица <b>"&amp;"</b>';
    const html = served(() => (
      <ChooseNameScreen chrome={chrome} view={{ typed, problem: NAME_REFUSED, rule: null }} />
    ));

    const box = nameBox(html);
    expect(readable(box.value ?? "")).toBe(typed);
    expect(box.invalid).toBe("true");
    expect(box.line).toBe(NAME_REFUSED);
    // The refusal already says the rule, so it is not said twice.
    expect(readable(html)).not.toContain(NAME_RULE);
  });

  it("follows a refusal that does not say the rule with the rule", () => {
    const html = served(() => (
      <ChooseNameScreen
        chrome={chrome}
        view={{ typed: "", problem: NAME_NEEDED, rule: NAME_RULE }}
      />
    ));

    const text = readable(html);
    expect(nameBox(html).line).toBe(NAME_NEEDED);
    expect(text.indexOf(NAME_RULE)).toBeGreaterThan(text.indexOf(NAME_NEEDED));
  });

  it("leads past the name to the cards, and to the settings where it is set later", () => {
    const html = served(() => (
      <ChooseNameScreen
        chrome={chrome}
        view={{ typed: "", problem: NAME_NEEDED, rule: NAME_RULE }}
      />
    ));

    expect(html).toContain('href="/dashboard/cards"');
    expect(html).toContain('href="/dashboard/settings"');
    expect(formTo(html, "post", "/choose-name")?.fields.get(DRAWN_FOR)).toBe(WHO);
  });
});
