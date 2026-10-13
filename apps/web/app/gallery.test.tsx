/**
 * The gallery's promise to whoever reviews the scanner there: every page the
 * route table declares, a route under `routes/` whose module draws something,
 * is shown in at least one state; every state the server draws is drawn
 * without failing, every part that loads on its own included; and every state
 * says where it appears, when a person sees it and what causes it. A page
 * added to `routes.ts` without a state fails here. The states the page's
 * script reaches are drawn in `gallery.behavior.test.tsx`.
 *
 * Left alone: the API, pictures and texts, which are no screens and live
 * outside `routes/`'s pages; whether a state looks right and whether its
 * sentences are true of the system, which the person reading the gallery
 * judges; the states a page can reach that have no example (one example per
 * page is all this asks); and whether the composed page meets its host's
 * rules, which `pnpm gallery` refuses to write otherwise.
 */

import type { RouteConfigEntry } from "@react-router/dev/routes";
import { prerender } from "react-dom/static";
import { matchRoutes, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";
import { gallery } from "./gallery";
import routes from "./routes";

const DRAWS = import.meta.glob<unknown>(["./routes/*.{ts,tsx}", "!./routes/*.test.{ts,tsx}"], {
  eager: true,
  import: "default",
});

const idOf = (entry: RouteConfigEntry): string => entry.id ?? entry.file.replace(/\.tsx?$/, "");

const asMatched = (entry: RouteConfigEntry): RouteObject =>
  entry.index === true
    ? { id: idOf(entry), index: true }
    : {
        id: idOf(entry),
        path: entry.path,
        caseSensitive: entry.caseSensitive,
        children: entry.children?.map(asMatched),
      };

/** A route with an address of its own whose module draws something there. */
const pagesIn = (entries: readonly RouteConfigEntry[]): string[] =>
  entries.flatMap((entry) => [
    ...((entry.path !== undefined || entry.index === true) && DRAWS[`./${entry.file}`] !== undefined
      ? [idOf(entry)]
      : []),
    ...pagesIn(entry.children ?? []),
  ]);

const TABLE: RouteObject[] = [{ id: "root", path: "/", children: routes.map(asMatched) }];

/** The route that answers a state's address, as React Router matches it. */
const answeredBy = (address: string): string | undefined =>
  matchRoutes(TABLE, new URL(address, "https://agentify.ad").pathname)?.at(-1)?.route.id;

const drawnWhole = async (state: (typeof gallery.states)[number]): Promise<string> => {
  const failures: unknown[] = [];
  const { prelude } = await prerender(state.draw(), {
    onError: (failure) => void failures.push(failure),
  });
  const html = await new Response(prelude).text();
  if (failures.length > 0) throw failures[0];
  return html;
};

describe("the scanner's gallery", () => {
  it("shows every page the route table declares in at least one state", () => {
    const shown = new Set(gallery.states.map((state) => answeredBy(state.address)));

    expect(pagesIn(routes).filter((page) => !shown.has(page))).toEqual([]);
  });

  it("puts every state at an address one of the scanner's pages answers", () => {
    const pages = new Set(pagesIn(routes));
    const astray = gallery.states.filter((state) => !pages.has(answeredBy(state.address) ?? ""));

    expect(astray.map((state) => `${state.id} at ${state.address}`)).toEqual([]);
  });

  it.each(
    gallery.states.filter((state) => state.scene === undefined).map((state) => [state.id, state]),
  )("draws %s as the server sends it, without failing", async (_id, state) => {
    expect(await drawnWhole(state)).toMatch(/<h1\b/);
  });

  it("says of every state which screen it is, when a person sees it and what causes it", () => {
    const silent = gallery.states.flatMap((state) =>
      (["screen", "when", "cause"] as const)
        .filter((field) => state[field].trim() === "")
        .map((field) => `${state.id} says nothing in ${field}`),
    );

    expect(silent).toEqual([]);
  });
});
