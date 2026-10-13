// @vitest-environment jsdom

/**
 * Which pages a link has the browser fetch while the pointer rests on it: a
 * public page, whose data a browser may keep, with the stylesheets it is drawn
 * with, and never a scan or a report, which are fetched only for a visitor who
 * asked for them.
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

const PAGES = [
  ["routes/methodology", "methodology"],
  ["routes/scan", "scan/:id"],
  ["routes/report", "report/:scanId"],
] as const;

/** What the build tells a browser of the pages it can fetch ahead. */
const FRAMEWORK = {
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
    ]),
    entry: { imports: [], module: "" },
    url: "",
    version: "",
  },
  routeModules: {},
  ssr: true,
  isSpaMode: false,
  routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
} as never;

const onTheFrontPage = () => {
  const router = createMemoryRouter(
    [
      {
        id: "root",
        path: "/",
        element: (
          <>
            <SiteLink to="/methodology">Methodology</SiteLink>
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
    <FrameworkContext.Provider value={FRAMEWORK}>
      <RouterProvider router={router} />
    </FrameworkContext.Provider>,
  );
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

/** Rests the pointer on a link long enough for the router's wait before it fetches. */
const restOn = async (name: string) => {
  await act(async () => {
    fireEvent.mouseEnter(screen.getByText(name));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
};

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

    await restOn("Methodology");

    expect(stylesAhead()).toEqual([]);
    drawn.remove();
  });

  it.each(["Your scan", "Your report"])("fetches nothing ahead for %s", async (name) => {
    onTheFrontPage();

    await restOn(name);

    expect(fetchedAhead()).toEqual([]);
  });
});
