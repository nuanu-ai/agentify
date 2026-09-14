import type { Page } from "playwright";

import { inspectRequest } from "./network-policy.js";

const NON_CONTENT_PATH =
  /(?:^|\/)(?:account|admin|api|auth|cart|checkout|delete|graphql|login|logout|oauth|remove|sign-in|signin|signout|unsubscribe|wp-admin)(?:\/|$)/i;
const ASSET_PATH =
  /\.(?:avif|css|csv|gif|ico|jpe?g|js|json|map|mjs|mov|mp3|mp4|pdf|png|svg|txt|webm|webp|woff2?|xml)$/i;
const REPRESENTATIVE_HINT =
  /(?:^|\/)(?:catalog|collection|item|menu|product|products|room|rooms|service|services|shop)(?:\/|$)/i;

const normalizedPageKey = (url: URL): string =>
  `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "") || "/"}`;

const rankCandidate = (url: URL): number => {
  const segments = url.pathname.split("/").filter(Boolean).length;
  return (REPRESENTATIVE_HINT.test(url.pathname) ? 100 : 0) + segments * 10;
};

export const selectRepresentativeUrls = (options: {
  rawUrls: readonly string[];
  baseUrl: string;
  allowedDomain: string;
  limit?: number;
}): URL[] => {
  const base = new URL(options.baseUrl);
  const baseKey = normalizedPageKey(base);
  const candidates = new Map<string, URL>();

  for (const raw of options.rawUrls.slice(0, 2_000)) {
    let parsed: URL;
    try {
      parsed = new URL(raw, base);
    } catch {
      continue;
    }
    if (parsed.search || parsed.hash) continue;
    if (base.protocol === "https:" && parsed.protocol !== "https:") continue;
    const decision = inspectRequest({
      url: parsed.toString(),
      method: "GET",
      isNavigation: true,
      allowedDomain: options.allowedDomain,
    });
    if (!decision.allowed) continue;
    if (
      decision.url.pathname === "/" ||
      NON_CONTENT_PATH.test(decision.url.pathname) ||
      ASSET_PATH.test(decision.url.pathname)
    ) {
      continue;
    }
    const key = normalizedPageKey(decision.url);
    if (key === baseKey) continue;
    candidates.set(key, decision.url);
  }

  return [...candidates.values()]
    .sort(
      (left, right) =>
        rankCandidate(right) - rankCandidate(left) ||
        left.toString().localeCompare(right.toString()),
    )
    .slice(0, Math.min(2, options.limit ?? 2));
};

export const discoverRepresentativeUrls = async (options: {
  page: Page;
  baseUrl: string;
  allowedDomain: string;
  limit?: number;
}): Promise<URL[]> => {
  const rawUrls = await options.page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .slice(0, 2_000)
      .map((link) => link.href),
  );
  return selectRepresentativeUrls({ ...options, rawUrls });
};
