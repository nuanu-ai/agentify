/**
 * The browser a surface's Chromium tests drive: the Chrome a Mac already has,
 * as the browser observer's test uses, and Playwright's own Chromium wherever
 * there is none, as on the CI runner after `playwright install chromium`.
 */

import { existsSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const launchChromium = (): Promise<Browser> =>
  chromium.launch(
    process.platform === "darwin" && existsSync(MAC_CHROME) ? { executablePath: MAC_CHROME } : {},
  );

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
