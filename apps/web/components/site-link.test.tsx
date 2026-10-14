// @vitest-environment jsdom

/**
 * Which pages a link has the browser fetch while the pointer rests on it: a
 * public page, whose data a browser may keep, with the stylesheets it is drawn
 * with, and never a scan or a report, which are fetched only for a visitor who
 * asked for them. A pointer that only passes over a link fetches nothing.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createMemoryRouter,
  UNSAFE_FrameworkContext as FrameworkContext,
  Outlet,
  RouterProvider,
} from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { SiteLink } from "./site-link";

afterEach(cleanup);

/** The pages the browser has been told of, with the page that says there is none. */
const PAGES = [
  ["routes/methodology", "methodology"],
  ["routes/scan", "scan/:id"],
  ["routes/report", "report/:scanId"],
  ["routes/not-found", "*"],
] as const;

/** What the build tells a browser of the pages it can fetch ahead. */
const frameworkOf = () => ({
  future: {},
  manifest: {
    routes: Object.fromEntries([
      ["root", { id: "root", path: "", hasLoader: true, module: "/assets/root.js" }],
      ...PAGES.map(([id, path]) => [
        id,
        {
          id,
          path,
          parentId: "root",
          hasLoader: true,
          module: `/assets/${id}.js`,
          css: [`/assets/${id}.css`],
        },
      ]),
    ]) as Record<string, { css: string[] }>,
    entry: { imports: [], module: "" },
    url: "",
    version: "",
  },
  routeModules: {},
  ssr: true,
  isSpaMode: false,
  routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
});

/**
 * The front page with links to a page the browser knows, to one it has not
 * been told of yet, and to a scan and a report; what the build told it can
 * be changed afterwards, as a page's discovery does.
 */
const onTheFrontPage = () => {
  const framework = frameworkOf();
  const router = createMemoryRouter(
    [
      {
        id: "root",
        path: "/",
        element: (
          <>
            <SiteLink to="/methodology">Methodology</SiteLink>
            <SiteLink to="/privacy">Privacy</SiteLink>
            <SiteLink to="/scan/0190f4c5-0000-7000-8000-000000000000">Your scan</SiteLink>
            <SiteLink to="/report/0190f4c5-0000-7000-8000-000000000000">Your report</SiteLink>
            <Outlet />
          </>
        ),
        children: PAGES.map(([id, path]) => ({ id, path, loader: () => null })),
      },
    ],
    { initialEntries: ["/"] },
  );
  render(
    <FrameworkContext.Provider value={framework as never}>
      <RouterProvider router={router} />
    </FrameworkContext.Provider>,
  );
  return framework.manifest;
};

/** The addresses the browser was told to fetch ahead. */
const fetchedAhead = () =>
  [...document.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"]')].map((link) =>
    link.getAttribute("href"),
  );

/** The stylesheets the browser was told to fetch ahead. */
const stylesAhead = () =>
  [...document.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"][as="style"]')].map((link) =>
    link.getAttribute("href"),
  );

const aMoment = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/** Rests the pointer on a link long enough for the wait before it fetches. */
const restOn = async (name: string) => {
  act(() => {
    fireEvent.mouseEnter(screen.getByText(name));
  });
  await aMoment(200);
};

const leave = (name: string) =>
  act(() => {
    fireEvent.mouseLeave(screen.getByText(name));
  });

describe("a link while the pointer rests on it", () => {
  it("has the browser fetch a public page's data and stylesheets ahead of the click", async () => {
    onTheFrontPage();

    await restOn("Methodology");

    expect(fetchedAhead().some((href) => href?.startsWith("/methodology.data"))).toBe(true);
    expect(stylesAhead()).toEqual(["/assets/routes/methodology.css"]);
  });

  it("fetches no stylesheet the window already has", async () => {
    onTheFrontPage();
    const drawn = document.createElement("link");
    drawn.rel = "stylesheet";
    drawn.href = "/assets/routes/methodology.css";
    document.head.append(drawn);
    try {
      await restOn("Methodology");

      expect(stylesAhead()).toEqual([]);
    } finally {
      drawn.remove();
    }
  });

  it("fetches nothing for a pointer that only passes over it", async () => {
    onTheFrontPage();

    act(() => {
      fireEvent.mouseEnter(screen.getByText("Methodology"));
    });
    await aMoment(20);
    leave("Methodology");
    await aMoment(200);

    expect(stylesAhead()).toEqual([]);
  });

  it("asks what the build says of the page each time the pointer rests on it", async () => {
    const manifest = onTheFrontPage();
    await restOn("Methodology");
    leave("Methodology");
    const methodology = manifest.routes["routes/methodology"];
    if (methodology !== undefined) methodology.css = ["/assets/routes/methodology-told-later.css"];

    await restOn("Methodology");

    expect(stylesAhead()).toContain("/assets/routes/methodology-told-later.css");
  });

  it("fetches no stylesheet for a page the browser has not been told of yet", async () => {
    onTheFrontPage();

    await restOn("Privacy");

    expect(stylesAhead()).toEqual([]);
  });

  it.each(["Your scan", "Your report"])("fetches nothing ahead for %s", async (name) => {
    onTheFrontPage();

    await restOn(name);

    expect(fetchedAhead()).toEqual([]);
  });
});
