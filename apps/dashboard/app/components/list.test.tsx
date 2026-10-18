// @vitest-environment jsdom

/**
 * What a screen reader makes of a long list's parts: a day over the orders
 * of that day is a heading it can move to, and a segment's label and count
 * are read as two words.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { askedIn, listingOf } from "../../src/listing.js";
import { DayHeading, List } from "./list.js";
import { ListTools } from "./listing.js";

afterEach(cleanup);

describe("a list's parts, as a screen reader meets them", () => {
  it("makes a day over its rows a heading", () => {
    render(
      <List label="All orders" columns="1fr">
        <DayHeading>12 October 2026</DayHeading>
      </List>,
    );

    expect(screen.getByRole("heading", { name: "12 October 2026" })).toBeTruthy();
  });

  it("reads a segment's label and its count apart", () => {
    const listing = listingOf({
      rows: [{ on: true }, { on: false }, { on: false }],
      asked: askedIn(new URLSearchParams(), ["all", "off"]),
      path: "/things",
      segments: [
        { key: "all", label: "All", holds: () => true, none: "" },
        { key: "off", label: "Off sale", holds: (row) => !row.on, none: "Nothing is off." },
      ],
      matches: () => true,
      noMatch: () => "",
      showAll: "Show all things",
    });
    const Stub = createRoutesStub([
      {
        path: "/things",
        Component: () => (
          <ListTools listing={listing} path="/things" label="Search things" placeholder="" />
        ),
      },
    ]);
    render(<Stub initialEntries={["/things"]} />);

    expect(screen.getByRole("link", { name: "Off sale 2" })).toBeTruthy();
  });
});
