/**
 * A long list cut to a page says how much of it is drawn, leads on and back
 * from the rows the page holds rather than by a count of rows, so a row that
 * arrives between two clicks moves no other; a search that matches nothing
 * says what was searched for, and every link keeps what the address asked of
 * the list.
 */

import { describe, expect, it } from "vitest";
import { askedIn, listingOf, placeOf, type SegmentRule } from "./listing.js";

interface Thing {
  readonly id: string;
  readonly at: number;
  readonly name: string;
  readonly on: boolean;
}

const SEGMENTS: readonly SegmentRule<Thing>[] = [
  { key: "all", label: "All", holds: () => true, none: "" },
  { key: "on", label: "On", holds: (row) => row.on, none: "Nothing is on." },
  { key: "off", label: "Off", holds: (row) => !row.on, none: "Nothing is off." },
];

const thing = (at: number): Thing => ({
  id: `t_${String(at).padStart(4, "0")}`,
  at: at * 10,
  name: at % 10 === 7 ? `lamp ${at}` : `chair ${at}`,
  on: at % 3 !== 0,
});

/** `count` things, the later the newer, every third one off, named so that a search can pick some out. */
const things = (count: number, from = 0): Thing[] =>
  Array.from({ length: count }, (_, at) => thing(from + at));

const listed = (rows: readonly Thing[], address = "", oldestFirst = false) =>
  listingOf({
    rows,
    asked: askedIn(
      new URLSearchParams(address),
      SEGMENTS.map((one) => one.key),
    ),
    path: "/things",
    segments: SEGMENTS,
    markOf: (row) => ({ key: [row.at], id: row.id }),
    ...(oldestFirst ? { oldestFirst } : {}),
    matches: (row, words) => row.name.includes(words),
    noMatch: (q, within) =>
      within === null ? `Nothing matches “${q}”.` : `Nothing ${within} matches “${q}”.`,
    showAll: "Show all things",
  });

/** The list as a link of it draws it: the address's own fields after the path. */
const followed = (rows: readonly Thing[], link: string | null | undefined) =>
  listed(rows, (link ?? "").replace(/^\/things\??/, ""));

const names = (shown: ReturnType<typeof listed>) => shown.rows.map((row) => row.name);

describe("a list cut short", () => {
  it("draws the newest fifty first, says which of how many, and has no way back from there", () => {
    const shown = listed(things(214));

    expect(shown.rows).toHaveLength(50);
    expect(shown.rows[0]?.name).toBe("chair 213");
    expect(shown.cut).toStrictEqual({
      from: 1,
      to: 50,
      of: 214,
      previous: null,
      next: "/things?after=1640.t_0164",
    });
  });

  it("leads on from the row the page ended on, and back to the rows nearest before the page", () => {
    const all = things(214);
    const second = followed(all, listed(all).cut?.next);
    const last = followed(all, followed(all, second.cut?.next).cut?.next);

    expect(second.rows[0]?.name).toBe("chair 163");
    expect(second.cut).toMatchObject({ from: 51, to: 100, previous: "/things?before=1630.t_0163" });
    expect(last.cut).toMatchObject({ from: 151, to: 200, next: "/things?after=140.t_0014" });
    const end = followed(all, last.cut?.next);
    expect(end.cut).toMatchObject({ from: 201, to: 214, of: 214, next: null });
    expect(names(followed(all, end.cut?.previous))).toStrictEqual(names(last));
    expect(names(followed(all, second.cut?.previous))).toStrictEqual(names(listed(all)));
  });

  it("neither repeats nor skips a row that arrives between two clicks, going on or going back", () => {
    const before = things(120);
    const first = listed(before);
    const arrived = [...before, ...things(3, 120)];
    const second = followed(arrived, first.cut?.next);

    expect(second.rows[0]?.name).toBe("chair 69");
    expect(second.cut).toMatchObject({ from: 54, to: 103, of: 123 });

    const again = [...arrived, thing(123)];
    const back = followed(again, second.cut?.previous);

    expect(names(back)).toStrictEqual(names(first));
    expect(back.cut).toMatchObject({ from: 5, to: 54, of: 124 });
    expect(back.cut?.previous).toBe("/things?before=1190.t_0119");
  });

  it("places a cursor whose row has left the segment, or the list, where its place falls", () => {
    const all = things(120);
    // Thing 60 is off, so the segment of things that are on never held it.
    const left = listed(all, "show=on&after=600.t_0060");
    const gone = listed(
      all.filter((one) => one.at !== 600),
      "show=on&after=600.t_0060",
    );

    expect(left.rows[0]?.name).toBe("chair 59");
    expect(names(gone)).toStrictEqual(names(left));
    expect(listed(all, "show=on&before=600.t_0060").rows.at(-1)?.name).toBe("chair 61");
  });

  it("draws the last page for a cursor past the end, and the first for one before the start", () => {
    const all = things(120);

    expect(names(listed(all, "after=-5.t_none"))).toStrictEqual(
      names(listed(all, "before=-5.t_none")),
    );
    expect(listed(all, "after=-5.t_none").cut).toMatchObject({ from: 71, to: 120, next: null });
    expect(names(listed(all, "before=99999.t_none"))).toStrictEqual(names(listed(all)));
  });

  it("reads a cursor that is no place, one named twice, and one each way at once as the first page", () => {
    const all = things(120);
    const first = names(listed(all));

    for (const address of [
      "after=yesterday",
      "after=600",
      "after=600.",
      "after=t_0060.600",
      "after=99999999999999999.t_0060",
      "after=600.t_%00",
      "after=600.t_0060&after=700.t_0070",
      "after=600.t_0060&before=700.t_0070",
    ]) {
      expect(names(listed(all, address)), address).toStrictEqual(first);
    }
  });

  it("leads on to the newer rows where the list is sorted from the oldest", () => {
    const all = things(120);
    const first = listed(all, "", true);

    expect(first.rows[0]?.name).toBe("chair 0");
    expect(first.cut?.next).toBe("/things?after=490.t_0049");
    expect(listed(all, "after=490.t_0049", true).rows[0]?.name).toBe("chair 50");
  });

  it("says nothing about cutting a list it draws whole", () => {
    expect(listed(things(50)).cut).toBeNull();
    expect(listed(things(50)).rows).toHaveLength(50);
  });
});

describe("a search and a segment", () => {
  it("counts each segment among the rows the search found", () => {
    const shown = listed(things(30), "q=lamp");

    expect(names(shown)).toStrictEqual(["lamp 27", "lamp 17", "lamp 7"]);
    expect(shown.segments.map((one) => [one.label, one.count])).toStrictEqual([
      ["All", 3],
      ["On", 2],
      ["Off", 1],
    ]);
  });

  it("keeps the search in every segment's link, and starts each at its first page", () => {
    const shown = listed(things(214), "q=chair&after=1640.t_0164");

    expect(shown.segments.map((one) => one.to)).toStrictEqual([
      "/things?q=chair",
      "/things?q=chair&show=on",
      "/things?q=chair&show=off",
    ]);
  });

  it("keeps the search and the segment in the links on and back", () => {
    const shown = listed(things(400), "q=chair&show=on&after=3000.t_0300");

    expect(shown.cut?.previous).toMatch(/^\/things\?q=chair&show=on&before=\d+\.t_\d{4}$/);
    expect(shown.cut?.next).toMatch(/^\/things\?q=chair&show=on&after=\d+\.t_\d{4}$/);
    expect(shown.search).toStrictEqual({ q: "chair", show: "on", cutAt: null });
  });

  it("starts a search over at the first page, and clears it there", () => {
    const shown = listed(things(214), "q=sofa&after=1640.t_0164");

    expect(shown.nothing?.way.to).toBe("/things");
  });

  it("reads a value the address names twice as not named", () => {
    const shown = listed(things(30), "q=lamp&q=chair&show=on&show=off");

    expect(shown.search).toStrictEqual({ q: "", show: null, cutAt: null });
    expect(shown.rows).toHaveLength(30);
  });
});

describe("the place a press on the list carries back", () => {
  const KEYS = SEGMENTS.map((one) => one.key);

  it("names the search, the segment and the cursor of the page drawn, and leads back to that page", () => {
    const all = things(400);
    const shown = listed(all, "q=chair&show=on&before=2000.t_0200");

    expect(shown.place).toStrictEqual({ q: "chair", show: "on", before: "2000.t_0200" });
    const back = placeOf("/things", new URLSearchParams(shown.place), KEYS);
    expect(back).toBe("/things?q=chair&show=on&before=2000.t_0200");
    expect(names(followed(all, back))).toStrictEqual(names(shown));
  });

  it("names the page drawn rather than a cursor past the end, and nothing at its default", () => {
    const all = things(120);

    expect(
      names(
        followed(
          all,
          placeOf("/things", new URLSearchParams(listed(all, "after=-5.t_none").place), KEYS),
        ),
      ),
    ).toStrictEqual(names(listed(all, "after=-5.t_none")));
    expect(listed(things(30)).place).toStrictEqual({});
    expect(listed(all, "before=1190.t_0119").place).toStrictEqual({});
    expect(placeOf("/things", new URLSearchParams(), KEYS)).toBe("/things");
  });

  it("reads what a form carried as the list's own address is read", () => {
    // A segment nobody defined, a cursor that is no place, and a value named
    // twice are each the default, never an address of their own.
    const read = (fields: string) => placeOf("/things", new URLSearchParams(fields), KEYS);

    expect(read("q=lamp&show=sofa&after=yesterday")).toBe("/things?q=lamp");
    expect(read("q=a&q=b&show=off&after=1.t_0001&after=2.t_0002")).toBe("/things?show=off");
    expect(read("q=%20lamp%20&after=40.t_0004")).toBe("/things?q=lamp&after=40.t_0004");
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

describe("a search longer than any name", () => {
  it("is matched and given back at its first 200 characters, and says it was cut", () => {
    const long = `lamp${"x".repeat(296)}`;
    const shown = listed(things(30), `q=${long}`);

    expect(shown.search.q).toBe(long.slice(0, 200));
    expect(shown.search.cutAt).toBe(200);
    expect(shown.nothing?.says).toBe(`Nothing matches “${long.slice(0, 200)}”.`);
  });

  it("is not called cut when it fits", () => {
    expect(listed(things(30), "q=lamp").search.cutAt).toBeNull();
  });

  it("cuts between characters, never inside one", () => {
    // Each of these takes two units of a JavaScript string; cut by units, the
    // last would be half a character.
    const shown = listed(things(3), `q=${"😀".repeat(250)}`);

    expect([...shown.search.q]).toHaveLength(200);
    expect(shown.search.q.endsWith("😀")).toBe(true);
  });
});
