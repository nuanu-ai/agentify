/**
 * The three answers the door gives to a request for a link, and the one script.
 *
 * All three carry the resend, and none of them carries it `disabled`. That is
 * the promise this file exists for: the cabinet serves a button that works and
 * a script takes it away for the length of the wait, never the other way
 * round. Rendered `disabled`, the button could not be given back — nothing on
 * a page whose script did not run can lift the attribute — and the one control
 * that asks for a new link would be dead in the browser of somebody who has no
 * other way into their cabinet.
 *
 * The script is tested by being run, twice over and never from a copy. Once
 * against a stand-in for the two properties it touches, which is cheap enough
 * to walk a forty-seven-minute countdown through every unit it changes into.
 * And once in jsdom, which parses the page the cabinet serves and runs the
 * script inside it.
 *
 * The second is there because the first was green while the feature was dead.
 * A stand-in answers any selector the same way wherever the script sits in the
 * document, so moving the script above the card — the tidy-up any later
 * refactor makes — left it finding no button, doing nothing, and passing. What
 * only a browser can be asked is whether the script can reach the button on
 * the page as served.
 */

import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { type LinkAnswer, linkRequestedScreen, openLinkScreen } from "./sign-in.js";
import { readable, waitingButton } from "./testing/html.js";

const PERSON = "dmitry@example.com";

/** The three pages, each with the wait the door computed for it. */
const ANSWERS: readonly (readonly [string, LinkAnswer])[] = [
  ["a link has just gone out", { sent: true, seconds: 60 }],
  ["the last link went out seconds ago", { wall: "interval", seconds: 43 }],
  ["this hour's three links are spent", { wall: "hourly", seconds: 2_820 }],
];

const screenFor = (answer: LinkAnswer): string =>
  linkRequestedScreen("", "sandbox", PERSON, "default", answer);

describe("what a merchant is served after asking for a link", () => {
  for (const [said, answer] of ANSWERS) {
    it(`keeps the resend on the page when ${said}`, () => {
      const html = screenFor(answer);

      expect(html).toContain('method="post" action="/sign-in"');
      expect(html).toContain(`name="email" type="hidden" value="${PERSON}"`);
      expect(readable(html)).toContain("Send another link");
      // The way out for somebody who mistyped their address stays beside it.
      expect(html).toContain('method="get" action="/sign-in"');
    });

    it(`serves that button pressable and carrying its wait when ${said}`, () => {
      const button = waitingButton(screenFor(answer));

      // Production break: served `disabled`, this button never comes back for
      // a browser that runs no script, and that browser's owner is locked out.
      expect(button.attributes.has("disabled")).toBe(false);
      expect(button.attributes.get("data-link-wait")).toBe(String(answer.seconds));
      // The number is on the attribute and not in the words, because a page is
      // a snapshot: a counter printed into the label would still say 43 in ten
      // minutes for everybody whose browser ran nothing to move it.
      expect(button.label).toBe("Send another link");
    });
  }

  it("says which wall was hit, and says nothing of the other one", () => {
    const sent = readable(screenFor({ sent: true, seconds: 60 }));
    const minute = readable(screenFor({ wall: "interval", seconds: 43 }));
    const hour = readable(screenFor({ wall: "hourly", seconds: 2_820 }));

    expect(sent).toContain("is on its way");
    expect(minute).toContain("No new link was sent");
    expect(minute).not.toContain("three links an hour");
    expect(hour).toContain("three links an hour");
    expect(hour).toContain("Try again in 47 minutes");
  });

  it("claims nothing about the link already gone out that the rate row does not hold", () => {
    const minute = readable(screenFor({ wall: "interval", seconds: 43 }));

    // The row is an address hash, a purpose and a time. Not the destination:
    // the earlier link may have been asked for elsewhere in the cabinet and
    // opens there, so a merchant coming back from their shop cannot be told
    // that the link in flight is the one they just asked for. And not
    // delivery: the door hands a message to a provider and hears no more.
    expect(minute).not.toContain("on its way");
    expect(minute).not.toContain("the last one");
  });

  it("does not offer another link from this page when the hour is what the next one waits for", () => {
    const short = readable(screenFor({ sent: true, seconds: 60 }));
    const long = readable(screenFor({ sent: true, seconds: 2_820 }));

    expect(short).toContain("send another link from this page");
    // A wait this long can only be the hourly wall — the interval is a minute
    // measured from a send a moment old — so this page's three links are gone.
    // Inviting the press under a button greyed for forty-seven minutes is the
    // same defect as the one the minute between links exists to remove.
    expect(long).not.toContain("send another link from this page");
    expect(long).toContain("three links for the hour");
  });

  it("does not round its words differently from the number on the button", () => {
    // Found in review: a sixty-one-second hourly wall said "Try again in 2
    // minutes" over a button counting "(61 s)". Nobody is sent back early, but
    // a page that argues with itself is believed at its worst number.
    const said = readable(screenFor({ wall: "hourly", seconds: 61 }));

    expect(said).toContain("Try again in 61 seconds");
    expect(said).not.toContain("2 minutes");
  });
});

/**
 * A stand-in for the two properties the script touches, and the lookup that
 * reaches them.
 *
 * It is here for the clock: the countdown below is walked minute by minute
 * without waiting for any of them. What it cannot see is everything about the
 * page around the button — where the script sits, whether the selector matches
 * anything, what a real DOM does with `disabled` — and that is what the jsdom
 * tests after it are for. Neither replaces the other.
 */
const standInFor = (html: string) => {
  const served = waitingButton(html);
  const button = {
    disabled: served.attributes.has("disabled"),
    textContent: served.label,
    getAttribute: (name: string): string | null => served.attributes.get(name) ?? null,
  };
  return {
    button,
    document: {
      querySelector: (selector: string) => {
        const wanted = selector.match(/^\[([\w-]+)]$/);
        const name = wanted?.[1];
        return name !== undefined && served.attributes.has(name) ? button : null;
      },
    },
  };
};

/** The script the page serves, run the way a browser reaching it would run it. */
const run = (html: string, document: unknown): void => {
  const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (source === undefined) throw new Error("this page serves no script");
  runInNewContext(source, { document, setInterval, clearInterval, Date });
};

describe("the script that waits the wait out", () => {
  it("takes the button away for the wait and gives it back when the wait is up", () => {
    const html = screenFor({ wall: "interval", seconds: 43 });
    const { button, document } = standInFor(html);

    vi.useFakeTimers();
    try {
      run(html, document);
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe("Send another link (43 s)");

      vi.advanceTimersByTime(40_000);
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe("Send another link (3 s)");

      vi.advanceTimersByTime(3_000);
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe("Send another link");

      // And it stops touching the page. The label is moved out from under it:
      // a counter still running would write over whatever is there, every
      // second, for as long as the page stays open.
      button.textContent = "left alone";
      vi.advanceTimersByTime(10_000);
      expect(button.textContent).toBe("left alone");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts an hour's wait in minutes and drops to seconds near the end", () => {
    const html = screenFor({ wall: "hourly", seconds: 2_820 });
    const { button, document } = standInFor(html);

    vi.useFakeTimers();
    try {
      run(html, document);
      expect(button.textContent).toBe("Send another link (47 min)");

      vi.advanceTimersByTime(2_729_000);
      expect(button.textContent).toBe("Send another link (2 min)");

      vi.advanceTimersByTime(1_000);
      expect(button.textContent).toBe("Send another link (90 s)");

      vi.advanceTimersByTime(90_000);
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe("Send another link");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The page in a browser, on a clock this test holds.
 *
 * jsdom parses the HTML the cabinet serves and runs the script inside it, so
 * what is under test includes the two things a stand-in cannot see: that the
 * script is placed where it can find the button at all — moved above the card
 * it finds nothing, and the countdown is silently gone — and that a real DOM
 * agrees about what `disabled` and `textContent` mean.
 *
 * The clock is replaced before the page is parsed, because an inline script
 * runs while the document is being read and there is no moment afterwards to
 * swap anything. A test that waited out a real minute would be a minute slower
 * and no more certain.
 */
const pageIn = (html: string) => {
  let now = Date.parse("2026-09-22T12:00:00Z");
  let nextTimer = 1;
  const ticking = new Map<number, { fn: () => void; every: number; due: number }>();
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.Date.now = () => now;
      window.setInterval = (fn, every = 0) => {
        const id = nextTimer++;
        ticking.set(id, { fn, every, due: now + every });
        return id;
      };
      window.clearInterval = (id) => {
        if (id !== undefined) ticking.delete(id);
      };
    },
  });
  const found = dom.window.document.querySelector("button[data-link-wait]") as {
    disabled: boolean;
    textContent: string | null;
  } | null;
  if (found === null) throw new Error("no button with a wait was found on the parsed page");
  return {
    button: found,
    /** Time passes with the tab awake: every tick that falls due runs. */
    pass(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...ticking.values()]
          .filter((timer) => timer.due <= until)
          .sort((one, other) => one.due - other.due)[0];
        if (next === undefined) break;
        now = next.due;
        next.due = now + next.every;
        next.fn();
      }
      now = until;
    },
    /**
     * The tab was frozen and woke: all of that time passed and one tick
     * arrives. It is what a browser does to a background tab's timers, and it
     * is the reason the countdown is written against a deadline instead of
     * counting its own ticks.
     */
    wake(ms: number) {
      now += ms;
      for (const timer of [...ticking.values()]) {
        timer.due = now + timer.every;
        timer.fn();
      }
    },
  };
};

describe("the script in a browser", () => {
  it("finds the button on the page it is served on, and gives it back on time", () => {
    const page = pageIn(screenFor({ wall: "interval", seconds: 43 }));

    expect(page.button.disabled).toBe(true);
    expect(page.button.textContent).toBe("Send another link (43 s)");

    page.pass(43_000);

    expect(page.button.disabled).toBe(false);
    expect(page.button.textContent).toBe("Send another link");
  });

  it("gives the button back to a tab that slept through the whole wait", () => {
    const page = pageIn(screenFor({ sent: true, seconds: 60 }));

    // Production break: a counter that took a second off per tick would have
    // fifty-nine seconds left here and hold the button for another minute,
    // because a throttled tab gets one tick for the whole sleep and not sixty.
    page.wake(70_000);

    expect(page.button.disabled).toBe(false);
    expect(page.button.textContent).toBe("Send another link");
  });

  it("counts down in the unit the words above it are written in", () => {
    const html = screenFor({ wall: "hourly", seconds: 61 });

    const page = pageIn(html);

    expect(readable(html)).toContain("Try again in 61 seconds");
    expect(page.button.textContent).toBe("Send another link (61 s)");
  });
});

describe("the page a mail link lands on", () => {
  it("runs nothing at all", () => {
    // It holds a one-time token, and ADR-0009 §3 keeps the enhancement to the
    // one screen that has a wait to draw. Nothing here has one.
    expect(openLinkScreen("", "a-token", "sandbox")).not.toContain("<script");
  });
});
