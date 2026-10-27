/**
 * The documentation's pages for the gallery (`pnpm gallery`): every page, and
 * the page for an address it has no page at, each drawn through the route
 * tree `routes.ts` declares, in the body every page is drawn in, with the data
 * the build's own loaders give it, as the live channel's Caddy serves it. The
 * privacy choices, which only a press opens over a page, are drawn with a
 * scene: what the tab's browser keeps and what the site answers the page's
 * requests with. Nothing here runs on the site.
 */

import {
  CONSENT_POLICY_VERSION,
  CONSENT_STORAGE_KEY,
  createConsentSnapshot,
} from "@agentify/analytics/browser";
import { BannerAnswered } from "@agentify/consent";
import type { GalleryState, GallerySurface } from "@agentify/gallery";
import { DOCS_PAGES, docsAddress } from "@agentify/ui/docs";
import type { ComponentType } from "react";
import { createRoutesStub, type LoaderFunctionArgs, Meta, type MetaFunction } from "react-router";
import { fillTemplates } from "../testing/caddy-templates.js";
import { CHANNELS } from "../testing/edge.js";
import { DocsBody } from "./root.js";
import * as Page from "./routes/page.js";
import { servedTemplate } from "./served.js";

type StubRoute = Parameters<typeof createRoutesStub>[0][number];

/** In the body every page is drawn in, after the head the layout writes. */
const inBody = (Drawn: ComponentType) =>
  function InBody() {
    return (
      <>
        <Meta />
        <DocsBody>
          <Drawn />
        </DocsBody>
      </>
    );
  };

const TREE: StubRoute[] = [
  {
    id: "root",
    path: "/",
    // As `routes.ts` declares them: the front page by name, every other by the splat.
    children: [
      {
        id: "front",
        index: true,
        Component: inBody(Page.default),
        meta: Page.meta as MetaFunction,
      },
      { id: "page", path: "*", Component: inBody(Page.default), meta: Page.meta as MetaFunction },
    ],
  },
];

/** The part every page carries, as the live channel's Caddy fills it. */
const SERVED = fillTemplates(servedTemplate(), CHANNELS.live);

const loadedAt = (path: string) =>
  Page.loader({ params: { "*": path.slice(1) } } as unknown as LoaderFunctionArgs);

/**
 * As a visitor who has answered the consent banner sees the page, since the
 * banner would cover its foot; on a first visit the banner is up over it.
 */
const drawnAt = async (path: string, firstVisit = false) => {
  const loaded = await loadedAt(path);
  return () => {
    const Stub = createRoutesStub(TREE);
    return (
      <>
        <Stub
          initialEntries={[path]}
          hydrationData={{ loaderData: { root: { served: SERVED }, front: loaded, page: loaded } }}
        />
        {firstVisit ? null : <BannerAnswered />}
      </>
    );
  };
};

/** Who is visiting, which every page's header asks the site: nobody signed in. */
const SIGNED_OUT = { "GET /api/v2/session": { status: 200, body: { status: "signed_out" } } };

/** A visitor's answer to the banner as their browser keeps it: essential processing only. */
const ESSENTIAL_ONLY = JSON.stringify(
  createConsentSnapshot({
    policyVersion: CONSENT_POLICY_VERSION,
    decisions: {},
    source: "banner",
    capturedAt: new Date("2026-10-20T09:00:00Z"),
  }),
);

/** The screen the front page's states are named under, as the contents call it. */
const FRONT = DOCS_PAGES.find((page) => page.path === "/")?.label;
if (FRONT === undefined) throw new Error("the documentation lists no front page");

const press = (page: Document, selector: string) => {
  const button = page.querySelector<HTMLElement>(selector);
  if (button === null) throw new Error(`the page draws no ${selector}`);
  button.click();
};

const pages: GalleryState[] = await Promise.all(
  DOCS_PAGES.map(async (page) => ({
    id: `docs${page.path === "/" ? "-front" : page.path.replaceAll("/", "-")}`,
    screen: page.label,
    address: docsAddress(page.path),
    when: "Somebody reads the documentation, from the site's Docs door or a link into it.",
    cause: `The page drawn from its Markdown at build time, under the contents of the documentation.`,
    draw: await drawnAt(page.path),
  })),
);

export const gallery: GallerySurface = {
  id: "docs",
  name: "Documentation",
  lang: "en",
  states: [
    ...pages,
    {
      id: "docs-front-first-visit",
      screen: FRONT,
      address: docsAddress("/"),
      when: "Somebody opens the documentation for the first time, or after clearing what their browser keeps.",
      cause:
        "The browser keeps no answer about measuring the visit, so the banner over the page asks for one.",
      draw: await drawnAt("/", true),
    },
    {
      id: "docs-front-privacy-choices",
      screen: FRONT,
      address: docsAddress("/"),
      when: "A reader who answered the banner presses Privacy choices in the footer.",
      cause:
        "The browser keeps their answer, essential processing only, so the preferences open on it.",
      draw: await drawnAt("/"),
      scene: {
        local: { [CONSENT_STORAGE_KEY]: ESSENTIAL_ONLY },
        answers: SIGNED_OUT,
        steps: [
          { shows: "Privacy choices", does: (page) => press(page, "footer button.foot-action") },
        ],
        shows: "Essential processing",
      },
    },
    {
      id: "docs-missing",
      screen: "Page not found",
      address: "/docs/no-such-page",
      when: "Somebody follows a link to an address the documentation has no page at.",
      cause: "Caddy answers an address it finds no file for with the page the build drew for it.",
      draw: await drawnAt("/404"),
    },
  ],
};
