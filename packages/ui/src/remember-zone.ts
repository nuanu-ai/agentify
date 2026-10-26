/** The browser's half of `zone.ts`: naming the browser's zone for the server. */

import { ZONE_COOKIE } from "./zone.js";

/**
 * Names this browser's zone in the cookie, for whatever the server draws
 * next; nothing already shown is rewritten. Written again only when the
 * browser's zone changed.
 */
export function rememberZone(): void {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone) return;
  const pair = `${ZONE_COOKIE}=${encodeURIComponent(zone)}`;
  if (document.cookie.split("; ").includes(pair)) return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing from browsers a few years old, and one plain write is all this needs
  document.cookie = `${pair}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}
