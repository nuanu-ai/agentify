/**
 * The gallery's promise to whoever reviews the dashboard there: every page the
 * route table declares, a route whose module draws something, is shown in at
 * least one state; every state is drawn without failing; and every state says
 * where it appears, when a person sees it and what causes it. A page added to
 * `routes.ts` without a state fails here.
 *
 * Left alone: whether a state looks right and whether its sentences are true
 * of the system, which the person reading the gallery judges; the states a
 * route can reach that have no example (one example per page is all this
 * asks); and whether the composed page meets its host's rules, which
 * `pnpm gallery` refuses to write otherwise.
 */

import type { RouteConfigEntry } from "@react-router/dev/routes";
import { renderToString } from "react-dom/server";
import { matchRoutes, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";
import config from "../react-router.config.js";
import { gallery } from "./gallery.js";
import routes from "./routes.js";

const DRAWS = import.meta.glob<unknown>(["./routes/*.{ts,tsx}", "!./routes/*.test.{ts,tsx}"], {
  eager: true,
  import: "default",
});

const idOf = (entry: RouteConfigEntry): string => entry.id ?? entry.file.replace(/\.tsx?$/, "");

const asMatched = (entry: RouteConfigEntry): RouteObject =>
  entry.index === true
    ? { id: idOf(entry), index: true }
    : { id: idOf(entry), path: entry.path, children: entry.children?.map(asMatched) };

/** A route with an address of its own whose module draws something there. */
const pagesIn = (entries: readonly RouteConfigEntry[]): string[] =>
  entries.flatMap((entry) => [
    ...((entry.path !== undefined || entry.index === true) && DRAWS[`./${entry.file}`] !== undefined
      ? [idOf(entry)]
      : []),
    ...pagesIn(entry.children ?? []),
  ]);

const TABLE: RouteObject[] = [{ id: "root", path: "/", children: routes.map(asMatched) }];

/** The route that answers a state's address, as React Router matches it under the prefix. */
const answeredBy = (address: string): string | undefined => {
  const path = new URL(address, "https://agentify.ad").pathname;
  if (!path.startsWith(`${config.basename}/`)) return undefined;
  return matchRoutes(TABLE, path.slice(config.basename.length))?.at(-1)?.route.id;
};

describe("the dashboard's gallery", () => {
  it("shows every page the route table declares in at least one state", () => {
    const shown = new Set(gallery.states.map((state) => answeredBy(state.address)));

    expect(pagesIn(routes).filter((page) => !shown.has(page))).toEqual([]);
  });

  it("puts every state at an address the dashboard answers, under its prefix", () => {
    const astray = gallery.states.filter((state) => answeredBy(state.address) === undefined);

    expect(astray.map((state) => `${state.id} at ${state.address}`)).toEqual([]);
  });

  it.each(gallery.states.map((state) => [state.id, state] as const))(
    "draws %s without failing",
    (_id, state) => {
      expect(renderToString(state.draw())).toMatch(/<h1\b/);
    },
  );

  it("says of every state which screen it is, when a person sees it and what causes it", () => {
    const silent = gallery.states.flatMap((state) =>
      (["screen", "when", "cause"] as const)
        .filter((field) => state[field].trim() === "")
        .map((field) => `${state.id} says nothing in ${field}`),
    );

    expect(silent).toEqual([]);
  });
});
