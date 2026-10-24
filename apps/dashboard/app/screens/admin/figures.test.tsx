/**
 * The figures screens drawn from the gallery's views, which the real view
 * functions built: a fact that could not be read is never drawn as nothing.
 */

import { SURFACE_MARKER_ATTRIBUTE } from "@agentify/core";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import type { OverviewView } from "../../../src/admin/figures.js";
import { readable } from "../../../src/testing/html.js";
import { FIGURES_STATES } from "../../admin-gallery/figures.js";
import { OverviewScreen } from "./figures.js";

const drawn = (screen: () => ReactElement): string => {
  const Stub = createRoutesStub([{ id: "root", path: "/", Component: screen }]);
  return renderToString(
    <Stub
      initialEntries={["/"]}
      hydrationData={{
        loaderData: {
          root: {
            base: "/dashboard",
            surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode: "live", words: null },
          },
        },
      }}
    />,
  );
};

const overviewOf = (id: string): OverviewView =>
  FIGURES_STATES.find((state) => state.id === id)?.loaded?.["routes/admin/index"] as OverviewView;

describe("the overview", () => {
  it("never says nothing is left unresolved over a fact worth a look that could not be read", () => {
    const unread = readable(
      drawn(() => <OverviewScreen view={overviewOf("dashboard-admin-overview-unread")} />),
    );

    expect(unread).toContain("Whether anything is worth a look about");
    expect(unread).not.toContain("Nothing the automation has left unresolved");
  });
});
