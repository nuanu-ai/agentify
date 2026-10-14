/**
 * A published result at its public link. The share is read from the database,
 * which a test does not have, so the stored share is stubbed and the route's
 * loader and head are asked directly; the page is drawn from what the loader
 * returned, as the browser draws it.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PublicSharePage } from "../../components/public-share-page";
import type { PublicAppConfig } from "../../lib/app-config";
import { visitTo } from "../../testing/loader-args";
import { onSite } from "../../testing/on-site";

const SLUG = "rbQ3x9VbN0m4p2kZcY7tWq";

const world = vi.hoisted(() => ({ shares: new Map<string, Record<string, unknown>>() }));

vi.mock("../../lib/server/reporting", () => ({
  getPublicShare: async (slug: string) => world.shares.get(slug),
}));

import { loader, meta } from "./s.slug";

const CONFIG: PublicAppConfig = {
  displayBrand: "Agentify",
  baseUrl: "https://agentify.ad",
  scannerUserAgent: "agentify-scanner/1.0 (+https://agentify.ad/scanner)",
  privacyEmail: "privacy@agentify.ad",
  abuseEmail: "abuse@agentify.ad",
  legalOperator: "Operator identity pending confirmation",
  legalIdentityConfirmed: false,
};

/** A published share as the database holds it, private columns included. */
const published = (allowIndexing: boolean) => ({
  id: "0190f4c5-0000-7000-8000-00000000a001",
  scanId: "0190f4c5-0000-7000-8000-00000000b001",
  shareSlugHash: "a-hash-the-link-is-looked-up-by",
  status: "published",
  allowIndexing,
  snapshot: {
    host: "www.shop.example",
    score: 46,
    level: "readable",
    rubric_version: "gtm-v1.0.0",
    generated_at: "2026-07-13T12:00:00.000Z",
  },
});

const load = (slug: string) => loader(visitTo(`https://agentify.ad/s/${slug}`, { slug }));

const headOf = async (slug: string) => {
  const loaderData = await load(slug);
  const tags = meta({
    loaderData,
    data: loaderData,
    params: { slug },
    matches: [{ id: "root", loaderData: { app: CONFIG } }],
  } as unknown as Parameters<typeof meta>[0]) as unknown as Record<string, string>[];
  return {
    title: tags.find((tag) => "title" in tag)?.title,
    named: (name: string) => tags.find((tag) => tag.name === name)?.content,
    property: (property: string) => tags.find((tag) => tag.property === property)?.content,
  };
};

beforeEach(() => {
  world.shares.clear();
});

describe("a public result", () => {
  it("is the page that says there is no such page where the link was never published or is revoked", async () => {
    const refused = await load("never-published-or-since-revoked").catch((thrown) => thrown);

    expect(refused).toMatchObject({ init: { status: 404 } });
  });

  it("shows the host, the level, the score and the day it was scanned, and offers a scan of one's own site", async () => {
    world.shares.set(SLUG, published(false));

    const { preview } = await load(SLUG);
    const page = renderToStaticMarkup(onSite(<PublicSharePage preview={preview} />));

    expect(page).toContain("www.shop.example");
    expect(page).toContain("Readable");
    expect(page).toContain("46");
    expect(page).toContain("Scanned Jul 13, 2026");
    expect(page).toContain('name="url"');
  });

  it("hands the browser nothing of the stored share beyond its public snapshot", async () => {
    world.shares.set(SLUG, published(true));

    const handed = JSON.stringify(await load(SLUG));

    expect(handed).not.toContain("0190f4c5");
    expect(handed).not.toContain("a-hash-the-link-is-looked-up-by");
  });

  it("unfurls into the result's own image, under its headline", async () => {
    world.shares.set(SLUG, published(false));

    const head = await headOf(SLUG);

    expect(head.title).toBe("shop.example exposes some agent-readable signals · Agentify");
    expect(head.property("og:title")).toBe("shop.example exposes some agent-readable signals");
    expect(head.property("og:image")).toBe(`https://agentify.ad/api/v1/shares/${SLUG}/image`);
    expect(head.named("twitter:image")).toBe(`https://agentify.ad/api/v1/shares/${SLUG}/image`);
    expect(head.named("twitter:card")).toBe("summary_large_image");
  });

  it.each([
    [true, "index, follow"],
    [false, "noindex, nofollow"],
  ])("is indexed and followed only where its owner allowed it: %s", async (allowed, robots) => {
    world.shares.set(SLUG, published(allowed));

    expect((await headOf(SLUG)).named("robots")).toBe(robots);
  });
});
