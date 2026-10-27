/**
 * The documentation's pages for the gallery (`pnpm gallery`): every page, and
 * the page for an address it has no page at, each drawn through the route
 * tree `routes.ts` declares, in the body every page is drawn in, with the data
 * the build's own loaders give it, as the live channel's Caddy serves it.
 * Nothing here runs on the site.
 */

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
 * As a visitor who has answered the consent banner sees the page: the scanner's
 * gallery draws the banner itself, the same one on every page of the origin.
 */
const drawnAt = async (path: string) => {
  const loaded = await loadedAt(path);
  return () => {
    const Stub = createRoutesStub(TREE);
    return (
      <>
        <Stub
          initialEntries={[path]}
          hydrationData={{ loaderData: { root: { served: SERVED }, front: loaded, page: loaded } }}
        />
        <BannerAnswered />
      </>
    );
  };
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
      id: "docs-missing",
      screen: "Page not found",
      address: "/docs/no-such-page",
      when: "Somebody follows a link to an address the documentation has no page at.",
      cause: "Caddy answers an address it finds no file for with the page the build drew for it.",
      draw: await drawnAt("/404"),
    },
  ],
};
