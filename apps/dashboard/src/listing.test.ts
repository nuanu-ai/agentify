/**
 * A long list cut to a page says how much of it is drawn, a search that
 * matches nothing says what was searched for, and every link keeps what the
 * address asked of the list.
 */

import { describe, expect, it } from "vitest";
import { askedIn, listingOf, type SegmentRule } from "./listing.js";

interface Thing {
  readonly name: string;
  readonly on: boolean;
}

const SEGMENTS: readonly SegmentRule<Thing>[] = [
  { key: "all", label: "All", holds: () => true, none: "" },
  { key: "on", label: "On", holds: (row) => row.on, none: "Nothing is on." },
  { key: "off", label: "Off", holds: (row) => !row.on, none: "Nothing is off." },
];

/** `count` things, every third one off, named so that a search can pick some out. */
const things = (count: number): Thing[] =>
  Array.from({ length: count }, (_, at) => ({
    name: at % 10 === 7 ? `lamp ${at}` : `chair ${at}`,
    on: at % 3 !== 0,
  }));

const listed = (rows: readonly Thing[], address = "") =>
  listingOf({
    rows,
    asked: askedIn(
      new URLSearchParams(address),
      SEGMENTS.map((one) => one.key),
    ),
    path: "/things",
    segments: SEGMENTS,
    matches: (row, words) => row.name.includes(words),
    noMatch: (q, within) =>
      within === null ? `Nothing matches “${q}”.` : `Nothing ${within} matches “${q}”.`,
    showAll: "Show all things",
  });

describe("a list cut short", () => {
  it("draws at most fifty rows and says which of how many", () => {
    const shown = listed(things(214));

    expect(shown.rows).toHaveLength(50);
    expect(shown.rows[0]?.name).toBe("chair 0");
    expect(shown.cut).toStrictEqual({
      from: 1,
      to: 50,
      of: 214,
      previous: null,
      next: "/things?page=2",
    });
  });

  it("leads both ways from a page in the middle, and stops at the last", () => {
    const middle = listed(things(214), "page=3");
    const last = listed(things(214), "page=5");

    expect(middle.rows[0]?.name).toBe("chair 100");
    expect(middle.cut).toMatchObject({ from: 101, to: 150, previous: "/things?page=2" });
    expect(middle.cut?.next).toBe("/things?page=4");
    expect(last.cut).toMatchObject({ from: 201, to: 214, of: 214, next: null });
  });

  it("draws the last page for an address past it, rather than no rows", () => {
    const past = listed(things(120), "page=9");

    expect(past.rows).toHaveLength(20);
    expect(past.cut).toMatchObject({ from: 101, to: 120, of: 120 });
  });

  it("says nothing about cutting a list it draws whole", () => {
    expect(listed(things(50)).cut).toBeNull();
    expect(listed(things(50)).rows).toHaveLength(50);
  });
});

describe("a search and a segment", () => {
  it("counts each segment among the rows the search found", () => {
    const shown = listed(things(30), "q=lamp");

    expect(shown.rows.map((row) => row.name)).toStrictEqual(["lamp 7", "lamp 17", "lamp 27"]);
    expect(shown.segments.map((one) => [one.label, one.count])).toStrictEqual([
      ["All", 3],
      ["On", 2],
      ["Off", 1],
    ]);
  });

  it("keeps the search in every segment's link, and starts each at its first page", () => {
    const shown = listed(things(214), "q=chair&page=2");

    expect(shown.segments.map((one) => one.to)).toStrictEqual([
      "/things?q=chair",
      "/things?q=chair&show=on",
      "/things?q=chair&show=off",
    ]);
  });

  it("keeps the search and the segment in the links to the other pages", () => {
    const shown = listed(things(400), "q=chair&show=on&page=2");

    expect(shown.cut?.previous).toBe("/things?q=chair&show=on");
    expect(shown.cut?.next).toBe("/things?q=chair&show=on&page=3");
    expect(shown.search).toStrictEqual({ q: "chair", show: "on" });
  });

  it("reads a value the address names twice as not named", () => {
    const shown = listed(things(30), "q=lamp&q=chair&show=on&show=off");

    expect(shown.search).toStrictEqual({ q: "", show: null });
    expect(shown.rows).toHaveLength(30);
  });
});

describe("a list that draws no row", () => {
  it("says what was searched for where nothing matches, and leads back to every row", () => {
    const shown = listed(things(30), "q=sofa&show=on");

    expect(shown.rows).toStrictEqual([]);
    expect(shown.nothing).toStrictEqual({
      says: "Nothing On matches “sofa”.",
      way: { to: "/things?show=on", words: "Clear the search" },
    });
  });

  it("says a segment holds nothing in other words than a search with no match", () => {
    const allOn = things(30).map((row) => ({ ...row, on: true }));

    expect(listed(allOn, "show=off").nothing).toStrictEqual({
      says: "Nothing is off.",
      way: { to: "/things", words: "Show all things" },
    });
  });

  it("leaves a list with no rows at all to its screen's own sentence", () => {
    // "Nothing yet" is the screen's to say, with the way to a first row.
    expect(listed([], "q=sofa").nothing).toBeNull();
    expect(listed([]).nothing).toBeNull();
  });
});
