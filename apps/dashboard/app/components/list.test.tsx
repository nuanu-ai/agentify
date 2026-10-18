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
import { DayHeading, List, Row, RowMore } from "./list.js";
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

  it("names each row's opened part by the row it belongs to", () => {
    render(
      <List label="Product cards" columns="1fr">
        <Row>
          <RowMore summary="Price date" of="VPN, one month">
            Since 1 October
          </RowMore>
        </Row>
        <Row>
          <RowMore summary="Price date" of="VPN, one year">
            Since 2 October
          </RowMore>
        </Row>
      </List>,
    );

    expect(screen.getByLabelText("Price date for VPN, one month")).toBeTruthy();
    expect(screen.getByLabelText("Price date for VPN, one year")).toBeTruthy();
  });

  it("says how many characters of a search that was cut were searched for, and shows those", () => {
    const tools = (q: string) => {
      const listing = listingOf({
        rows: [{ on: true }],
        asked: askedIn(new URLSearchParams({ q }), ["all"]),
        path: "/things",
        segments: [{ key: "all", label: "All", holds: () => true, none: "" }],
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
    };

    tools("x".repeat(300));
    expect(screen.getByRole("searchbox", { name: "Search things" })).toHaveProperty(
      "value",
      "x".repeat(200),
    );
    expect(screen.getByText(/\b200\b/)).toBeTruthy();
    cleanup();
    tools("lamp");
    expect(screen.queryByText(/\b200\b/)).toBeNull();
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
