/**
 * Every answer carries the resend button, and none serves it `disabled`: the
 * script takes it away for the length of the wait, because nothing can lift the
 * attribute where the script did not run, and a disabled button would lock out
 * somebody with no other way in.
 *
 * The script is run, never copied: once against a stand-in cheap enough to walk
 * a long countdown, and once in jsdom on the page as served, because only a
 * real document shows whether the script can reach the button at all (moved
 * above the card, it finds nothing and a stand-in still passes).
 */

import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { type LinkAnswer, linkRequestedScreen, openLinkScreen } from "./sign-in.js";
import { readable, waitingButton } from "./testing/html.js";

const PERSON = "owner@example.com";

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

      // Served `disabled`, the button never comes back for a browser that runs
      // no script.
      expect(button.attributes.has("disabled")).toBe(false);
      expect(button.attributes.get("data-link-wait")).toBe(String(answer.seconds));
      // The number is on the attribute, not in the words: a counter printed
      // into the label would stay frozen in a browser that ran nothing.
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

    // The page may say only what the rate row holds: not where the earlier link
    // leads, which may be elsewhere in the dashboard, and not delivery, which
    // is the provider's.
    expect(minute).not.toContain("on its way");
    expect(minute).not.toContain("the last one");
  });

  it("does not offer another link from this page when the hour is what the next one waits for", () => {
    const short = readable(screenFor({ sent: true, seconds: 60 }));
    const long = readable(screenFor({ sent: true, seconds: 2_820 }));

    expect(short).toContain("send another link from this page");
    // A wait this long can only be the hourly limit, so inviting a press under
    // a button greyed for forty-seven minutes would be wrong.
    expect(long).not.toContain("send another link from this page");
    expect(long).toContain("three links for the hour");
  });

  it("does not round its words differently from the number on the button", () => {
    // A sixty-one-second wait must not read "2 minutes" over a button counting
    // "(61 s)": a page that argues with itself is believed at its worst number.
    const said = readable(screenFor({ wall: "hourly", seconds: 61 }));

    expect(said).toContain("Try again in 61 seconds");
    expect(said).not.toContain("2 minutes");
  });
});

/**
 * Here for the clock, so the countdown is walked minute by minute without
 * waiting. It cannot see the page around the button; the jsdom tests below can.
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

      // A counter still running would write over whatever is there every
      // second.
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
 * The clock is replaced before the page is parsed, because an inline script
 * runs while the document is read and there is no later moment to swap it.
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
    /** The tab is awake: every tick that falls due runs. */
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
     * The tab was frozen: all that time passed and one tick arrives, as a
     * browser does with a background tab's timers.
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

    // A throttled tab gets one tick for the whole sleep, so a counter that took
    // a second off per tick would still hold the button here.
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
    // It holds a one-time token, and a script is allowed only where a control
    // has a wait to draw; nothing here has one.
    expect(openLinkScreen("", "a-token", "person@example.com", "sandbox")).not.toContain("<script");
  });
});
