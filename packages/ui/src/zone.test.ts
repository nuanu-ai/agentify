import { describe, expect, it } from "vitest";
import { dayIn, momentIn, ZONE_COOKIE, zoneIn } from "./zone.js";

const AT = new Date("2026-10-26T14:03:12.640Z");

describe("a moment written for a person", () => {
  it("is written in the viewer's zone and names that zone by its offset", () => {
    expect(momentIn(AT, "Asia/Makassar")).toEqual({
      date: "2026-10-26",
      time: "22:03:12",
      zone: "UTC+8",
    });
    expect(momentIn(AT, "America/Sao_Paulo")).toEqual({
      date: "2026-10-26",
      time: "11:03:12",
      zone: "UTC-3",
    });
  });

  it("names a zone off the hour with its minutes, and moves the date with the zone", () => {
    expect(momentIn(AT, "Asia/Kathmandu")).toEqual({
      date: "2026-10-26",
      time: "19:48:12",
      zone: "UTC+5:45",
    });
    expect(momentIn(new Date("2026-10-26T20:00:00Z"), "Asia/Kolkata")).toEqual({
      date: "2026-10-27",
      time: "01:30:00",
      zone: "UTC+5:30",
    });
  });

  it("names the offset in force at that moment, so two sides of a clock change differ", () => {
    expect(momentIn(new Date("2026-03-28T12:00:00Z"), "Europe/Berlin")).toMatchObject({
      time: "13:00:00",
      zone: "UTC+1",
    });
    expect(momentIn(new Date("2026-03-30T12:00:00Z"), "Europe/Berlin")).toMatchObject({
      time: "14:00:00",
      zone: "UTC+2",
    });
  });

  it("is written in UTC and says so where the viewer's zone is not known", () => {
    expect(momentIn(AT, null)).toEqual({ date: "2026-10-26", time: "14:03:12", zone: "UTC" });
  });

  it("is not written at all where the instant cannot be read", () => {
    expect(momentIn(new Date("not a time"), "Asia/Makassar")).toBeNull();
  });

  it("puts a day under the viewer's own calendar", () => {
    const evening = new Date("2026-10-26T20:00:00Z");
    expect(dayIn(evening, "Asia/Makassar")).toEqual({ year: 2026, month: 10, day: 27 });
    expect(dayIn(evening, null)).toEqual({ year: 2026, month: 10, day: 26 });
  });
});

describe("the zone a browser names", () => {
  const header = (zone: string) => `session=abc; ${ZONE_COOKIE}=${encodeURIComponent(zone)}; x=1`;

  it("is read from its cookie", () => {
    expect(zoneIn(header("Asia/Makassar"))).toBe("Asia/Makassar");
  });

  it("is unknown where the cookie is missing, empty or names no zone the server knows", () => {
    expect(zoneIn(null)).toBeNull();
    expect(zoneIn("session=abc")).toBeNull();
    expect(zoneIn(`${ZONE_COOKIE}=`)).toBeNull();
    expect(zoneIn(header("Mars/Olympus_Mons"))).toBeNull();
    expect(zoneIn(`${ZONE_COOKIE}=%E0%A4%A`)).toBeNull();
    expect(zoneIn(header("Europe/".repeat(40)))).toBeNull();
  });

  it("is taken only as a name from the time zone database, not as a bare offset", () => {
    // A browser names its zone by the database's name; offsets would let
    // anybody make the server keep thousands of clock faces.
    expect(zoneIn(header("+05:30"))).toBeNull();
    expect(zoneIn(header("-0130"))).toBeNull();
    expect(zoneIn(header("Etc/GMT-8"))).toBe("Etc/GMT-8");
  });

  it("is kept in one spelling however the browser cased it", () => {
    expect(zoneIn(header("asia/makassar"))).toBe("Asia/Makassar");
  });
});
