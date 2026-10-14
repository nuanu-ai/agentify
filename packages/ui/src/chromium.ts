/**
 * The browser a surface's Chromium tests drive: the Chrome a Mac already has,
 * as the browser observer's test uses, and Playwright's own Chromium wherever
 * there is none, as on the CI runner after `playwright install chromium`.
 */

import { existsSync } from "node:fs";
import { type Browser, chromium } from "playwright";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const launchChromium = (): Promise<Browser> =>
  chromium.launch(
    process.platform === "darwin" && existsSync(MAC_CHROME) ? { executablePath: MAC_CHROME } : {},
  );
