/**
 * The browser a surface's Chromium tests drive: Playwright's own Chromium on
 * every machine, the one the CI runner installs and whose verdict merges a
 * change. `AGENTIFY_TEST_BROWSER=chrome` asks for the Google Chrome installed
 * on the machine instead.
 */

import { type Browser, chromium, type LaunchOptions, type Locator, type Page } from "playwright";

/**
 * Headless, Playwright's Chromium is its headless shell, which a page can tell
 * from Chrome: it names itself HeadlessChrome among its brands, times its
 * frames differently, and is pinned by the lockfile while Chrome updates
 * itself. A pass in Chrome therefore says nothing of CI, and Chrome is asked
 * for by name.
 */
const launchOptions = (): LaunchOptions => {
  const asked = process.env.AGENTIFY_TEST_BROWSER;
  if (asked === undefined || asked === "") return {};
  if (asked === "chrome") return { channel: "chrome" };
  throw new Error(
    `AGENTIFY_TEST_BROWSER is "${asked}", which names no browser: "chrome" runs the Google Chrome installed here, and leaving it unset runs Playwright's Chromium, as CI does.`,
  );
};

export const launchChromium = (): Promise<Browser> => chromium.launch(launchOptions());

/**
 * A finger put on the window at `from`, drawn `by` pixels up, as a phone
 * scrolls a page down, and held still before it lifts, so what scrolls moves
 * by the drag alone rather than flinging on. Playwright has no drag of its
 * own for a finger, so the touches go through the browser's input as a
 * phone's would; the page's context needs `hasTouch`.
 */
export const dragUp = async (
  page: Page,
  from: Readonly<{ x: number; y: number }>,
  by: number,
): Promise<void> => {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", y?: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: y === undefined ? [] : [{ x: from.x, y }],
    });
  await touch("touchStart", from.y);
  for (let step = 1; step <= 10; step += 1) await touch("touchMove", from.y - (by * step) / 10);
  await page.waitForTimeout(200);
  await touch("touchMove", from.y - by);
  await touch("touchEnd");
  await cdp.detach();
};

/**
 * What the site header's bar shows: how far apart the middles of its items lie
 * (one row where it is a pixel at most), the section links it keeps, how many
 * parts of who is visiting it shows, and whether the menu's button is there.
 */
export const theBar = (
  header: Locator,
): Promise<Readonly<{ spread: number; sections: string[]; visitor: number; button: boolean }>> =>
  header.evaluate((element) => {
    const items = [
      ...element.querySelectorAll(
        ".brand, .site-nav > a, .site-doors > a, .site-doors .site-visitor > *, .site-menu > summary",
      ),
    ].filter((item) => item.getBoundingClientRect().width > 0);
    const middles = items.map((item) => {
      const box = item.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    return {
      spread: Math.max(...middles) - Math.min(...middles),
      sections: items
        .filter((item) => item.matches(".site-nav > a"))
        .map((item) => item.textContent ?? ""),
      visitor: items.filter((item) => item.matches(".site-visitor > *")).length,
      button: items.some((item) => item.matches("summary")),
    };
  });
