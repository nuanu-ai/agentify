// @vitest-environment jsdom

/**
 * Every answer to a request for a link carries the resend button, and none
 * serves it `disabled`: the page's script takes it away for the length of the
 * wait, because nothing can lift the attribute where the script did not run,
 * and a disabled button would lock out somebody with no other way in.
 *
 * Each page is drawn twice: as the server sends it, which is what a browser
 * without script keeps, and alive in a document, where the countdown runs on a
 * clock the test moves.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS, type SurfaceMode } from "@agentify/core";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkAnswer } from "../../src/page-services.js";
import { formTo, readable, waitingButton } from "../../src/testing/html.js";
import type { Chrome } from "../answer.js";
import { AskScreen, LinkRequestedScreen, OpenLinkScreen } from "./sign-in.js";

const PERSON = "owner@example.com";

const chromeIn = (mode: SurfaceMode): Chrome => ({
  base: "",
  surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode, words: SURFACE_WORDS[mode] },
});

/** The screens use the router's forms, so they are drawn inside a router. */
const routed = (screen: () => ReactElement) => {
  const Stub = createRoutesStub([{ path: "/sign-in", Component: screen }]);
  return <Stub initialEntries={["/sign-in"]} />;
};

const requested = (answer: LinkAnswer) =>
  routed(() => (
    <LinkRequestedScreen
      chrome={chromeIn("sandbox")}
      email={PERSON}
      destination="default"
      answer={answer}
      googleEnabled={false}
    />
  ));

/** As the server sends it: no effect has run. */
const served = (answer: LinkAnswer): string => renderToString(requested(answer));

const ANSWERS: readonly (readonly [string, LinkAnswer])[] = [
  ["a link has just gone out", { sent: true, seconds: 60 }],
  ["the last link went out seconds ago", { wall: "interval", seconds: 43 }],
  ["this hour's three links are spent", { wall: "hourly", seconds: 2_820 }],
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("what a page says about the stack it belongs to", () => {
  const signIn = (mode: SurfaceMode): string =>
    renderToString(
      routed(() => (
        <AskScreen
          chrome={chromeIn(mode)}
          view={{ screen: "ask", destination: "default", googleEnabled: false }}
        />
      )),
    );

  it("says nothing settles here on the laptop", () => {
    const html = signIn("sandbox");

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="sandbox"`);
    expect(readable(html)).toContain(SURFACE_WORDS.sandbox);
  });

  it("says payments settle with test funds on the test site", () => {
    const html = signIn("test");

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="test"`);
    expect(readable(html)).toContain(SURFACE_WORDS.test);
  });

  it("says nothing at all on the live one, and still names itself", () => {
    // The marker names the mode rather than merely existing: an absence cannot
    // tell a correct live page from one that failed to render.
    const html = signIn("live");

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="live"`);
    expect(readable(html)).not.toContain(SURFACE_WORDS.test);
    expect(readable(html)).not.toContain(SURFACE_WORDS.sandbox);
    // No banner element either: an empty styled one is a band across a live
    // page.
    expect(html).not.toContain('class="stack-note"');
  });
});

describe("the Google sign-in choice", () => {
  it("offers a separate browser post while keeping the email form and its destination", () => {
    const html = renderToString(
      routed(() => (
        <AskScreen
          chrome={chromeIn("sandbox")}
          view={{ screen: "ask", destination: "settings", googleEnabled: true }}
        />
      )),
    );

    const google = formTo(html, "post", "/sign-in/google");
    expect(google?.fields.get("destination")).toBe("settings");
    expect(formTo(html, "post", "/sign-in")?.fields.get("destination")).toBe("settings");
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(
      document.querySelector('form[action="/sign-in/google"] button')?.textContent?.trim(),
    ).toBe("Sign in with Google");
  });

  it("offers no unavailable Google choice and fills only the address its server view supplied", () => {
    const html = renderToString(
      routed(() => (
        <AskScreen
          chrome={chromeIn("sandbox")}
          view={{
            screen: "ask",
            destination: "keys",
            googleEnabled: false,
            email: PERSON,
          }}
        />
      )),
    );

    expect(formTo(html, "post", "/sign-in/google")).toBeUndefined();
    expect(formTo(html, "post", "/sign-in")?.fields.get("email")).toBe(PERSON);
  });
});

describe("the way to the privacy page", () => {
  it("is on the sign-in page itself, where a visitor from an ad is told nothing else of the report to the ad tracker", () => {
    const html = renderToString(
      routed(() => (
        <AskScreen
          chrome={chromeIn("sandbox")}
          view={{
            screen: "ask",
            destination: "default",
            googleEnabled: true,
            clickId: "qa_click_0123456789abcdef",
          }}
        />
      )),
    );

    const document = new DOMParser().parseFromString(html, "text/html");
    const card = document.querySelector("main");
    const privacy = [...(card?.querySelectorAll("a") ?? [])].find(
      (link) => link.textContent?.trim() === "Privacy",
    );
    expect(privacy?.getAttribute("href")).toBe("/privacy");
  });
});

describe("what a merchant is served after asking for a link", () => {
  for (const [said, answer] of ANSWERS) {
    it(`keeps the resend on the page when ${said}`, () => {
      const html = served(answer);

      expect(formTo(html, "post", "/sign-in")?.fields.get("email")).toBe(PERSON);
      expect(readable(html)).toContain("Send another link");
      // The way out for somebody who mistyped their address stays beside it.
      expect(formTo(html, "get", "/sign-in")).toBeDefined();
    });

    it(`serves that button pressable and carrying its wait when ${said}`, () => {
      const button = waitingButton(served(answer));

      // Served `disabled`, the button never comes back for a browser that runs
      // no script.
      expect(button.attributes.has("disabled")).toBe(false);
      expect(button.attributes.get("data-link-wait")).toBe(String(answer.seconds));
      // The number is not in the words: a counter printed into the label would
      // stay frozen in a browser that ran nothing.
      expect(button.label).toBe("Send another link");
    });
  }

  it("says which wall was hit, and says nothing of the other one", () => {
    const sent = readable(served({ sent: true, seconds: 60 }));
    const minute = readable(served({ wall: "interval", seconds: 43 }));
    const hour = readable(served({ wall: "hourly", seconds: 2_820 }));

    expect(sent).toContain("is on its way");
    expect(minute).toContain("No new link was sent");
    expect(minute).not.toContain("three links an hour");
    expect(hour).toContain("three links an hour");
    expect(hour).toContain("Try again in 47 minutes");
  });

  it("claims nothing about the link already gone out that the rate row does not hold", () => {
    const minute = readable(served({ wall: "interval", seconds: 43 }));

    // The page may say only what the rate row holds: not where the earlier link
    // leads, which may be elsewhere in the dashboard, and not delivery, which
    // is the provider's.
    expect(minute).not.toContain("on its way");
    expect(minute).not.toContain("the last one");
  });

  it("does not offer another link from this page when the hour is what the next one waits for", () => {
    const short = readable(served({ sent: true, seconds: 60 }));
    const long = readable(served({ sent: true, seconds: 2_820 }));

    expect(short).toContain("send another link from this page");
    // A wait this long can only be the hourly limit, so inviting a press under
    // a button greyed for forty-seven minutes would be wrong.
    expect(long).not.toContain("send another link from this page");
    expect(long).toContain("three links for the hour");
  });

  it("does not round its words differently from the number on the button", () => {
    // A sixty-one-second wait must not read "2 minutes" over a button counting
    // "(61 s)": a page that argues with itself is believed at its worst number.
    const said = readable(served({ wall: "hourly", seconds: 61 }));

    expect(said).toContain("Try again in 61 seconds");
    expect(said).not.toContain("2 minutes");
  });
});

/** The page alive in a document, its clock in the test's hands from the start. */
const alive = (answer: LinkAnswer) => {
  vi.useFakeTimers({ now: Date.parse("2026-09-22T12:00:00Z") });
  const { container } = render(requested(answer));
  const button = container.querySelector("button[data-link-wait]") as HTMLButtonElement | null;
  if (button === null) throw new Error("no button with a wait was found on the page");
  return {
    button,
    /** The tab is awake: every tick that falls due runs. */
    pass(ms: number) {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    },
    /**
     * The tab was frozen: all that time passed and one tick arrives, as a
     * browser does with a background tab's timers.
     */
    wake(ms: number) {
      act(() => {
        vi.setSystemTime(Date.now() + ms);
        vi.advanceTimersToNextTimer();
      });
    },
  };
};

describe("the script that waits the wait out", () => {
  it("takes the button away for the wait and gives it back when the wait is up", () => {
    const page = alive({ wall: "interval", seconds: 43 });

    expect(page.button.disabled).toBe(true);
    expect(page.button.textContent).toBe("Send another link (43 s)");

    page.pass(40_000);
    expect(page.button.disabled).toBe(true);
    expect(page.button.textContent).toBe("Send another link (3 s)");

    page.pass(3_000);
    expect(page.button.disabled).toBe(false);
    expect(page.button.textContent).toBe("Send another link");

    // A counter still running would keep writing over the words.
    page.pass(10_000);
    expect(page.button.textContent).toBe("Send another link");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts an hour's wait in minutes and drops to seconds near the end", () => {
    const page = alive({ wall: "hourly", seconds: 2_820 });
    expect(page.button.textContent).toBe("Send another link (47 min)");

    page.pass(2_729_000);
    expect(page.button.textContent).toBe("Send another link (2 min)");

    page.pass(1_000);
    expect(page.button.textContent).toBe("Send another link (90 s)");

    page.pass(90_000);
    expect(page.button.disabled).toBe(false);
    expect(page.button.textContent).toBe("Send another link");
  });

  it("gives the button back to a tab that slept through the whole wait", () => {
    const page = alive({ sent: true, seconds: 60 });

    // A throttled tab gets one tick for the whole sleep, so a counter that took
    // a second off per tick would still hold the button here.
    page.wake(70_000);

    expect(page.button.disabled).toBe(false);
    expect(page.button.textContent).toBe("Send another link");
  });

  it("counts down in the unit the words above it are written in", () => {
    const page = alive({ wall: "hourly", seconds: 61 });

    expect(readable(document.body.innerHTML)).toContain("Try again in 61 seconds");
    expect(page.button.textContent).toBe("Send another link (61 s)");
  });
});

describe("the link's page", () => {
  it("names the address it signs in and offers one button, which sends the token alone", () => {
    const { getAllByRole, container } = render(
      routed(() => (
        <OpenLinkScreen
          chrome={chromeIn("live")}
          view={{ screen: "open", token: "a".repeat(32), email: PERSON }}
        />
      )),
    );

    const buttons = getAllByRole("button") as HTMLButtonElement[];
    const sent = new FormData(buttons[0]?.form ?? undefined);

    expect(buttons.map((button) => [button.name, button.value])).toStrictEqual([["", ""]]);
    expect([...sent]).toStrictEqual([["token", "a".repeat(32)]]);
    expect(container.textContent).toContain(PERSON);
  });
});
