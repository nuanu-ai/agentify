/**
 * What the integrations screen says about the two ways in, drawn as the
 * server sends it. The states come from the shop's own rows and the gateway's
 * word on the integration, so each is built here as the reads hand them over;
 * the HTTP tests walk the reads.
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { integrationsView, type ThroughRead } from "../../src/integrations-view.js";
import { readable } from "../../src/testing/html.js";
import type { ShopTile } from "../../src/woo-views.js";
import { IntegrationsScreen } from "./integrations.js";

const SHOP = "https://shop.example";

const ON_THE_SHOP: ThroughRead = { through: "woocommerce", offSale: [] };
const ON_THE_CODE: ThroughRead = { through: "api", offSale: [] };

const drawn = (shop: ShopTile, through: ThroughRead): string =>
  renderToString(<IntegrationsScreen view={integrationsView(shop, through)} base="" />);

/** The two ways in, the merchant's own code first. */
const waysIn = (html: string): readonly [string, string] => {
  const [, code = "", shop = ""] = html.split('class="connect-way"');
  return [code, shop];
};

const primaryIn = (way: string): readonly string[] =>
  [...way.matchAll(/<a class="button button-primary" href="([^"]*)"/g)].map(([, to = ""]) => to);

const connected = (permissions: string): ShopTile => ({
  kind: "connected",
  shop: { shopUrl: SHOP, permissions, connectedAt: new Date("2026-08-26T12:00:00Z") },
});

describe("the way a merchant sells through, on the integrations screen", () => {
  it("marks the shop and leads there first while sales go through it", () => {
    const [code, shop] = waysIn(drawn(connected("read_write"), ON_THE_SHOP));

    expect(readable(shop)).toContain("In use");
    expect(primaryIn(shop)).toStrictEqual(["/woocommerce"]);
    expect(readable(code)).not.toContain("In use");
    expect(primaryIn(code)).toStrictEqual([]);
  });

  it("marks the shop as a warning, saying nothing sells, while sales go through a shop none connected", () => {
    for (const tile of [
      { kind: "none" },
      { kind: "waiting", shopUrl: SHOP, startedMinutesAgo: 2 },
      { kind: "unanswered", shopUrl: SHOP },
    ] as const satisfies readonly ShopTile[]) {
      const [, shop] = waysIn(drawn(tile, ON_THE_SHOP));

      expect(shop, tile.kind).toMatch(/<span class="badge badge-fail">In use<\/span>/);
      expect(readable(shop), tile.kind).toContain("Nothing sells until a shop is connected");
    }
    const [, connectedShop] = waysIn(drawn(connected("read_write"), ON_THE_SHOP));
    expect(connectedShop).toMatch(/<span class="badge badge-pass">In use<\/span>/);
    expect(readable(connectedShop)).not.toContain("Nothing sells");
  });

  it("marks the code, and leads to the shop only second, while a connected shop waits", () => {
    const [code, shop] = waysIn(drawn(connected("read_write"), ON_THE_CODE));

    expect(readable(code)).toContain("In use");
    expect(primaryIn(code)).toStrictEqual(["/docs/quickstart"]);
    expect(readable(shop)).not.toContain("In use");
    expect(primaryIn(shop)).toStrictEqual([]);
  });

  it("marks neither for a merchant who never touched a shop, and offers both alike", () => {
    const [code, shop] = waysIn(drawn({ kind: "none" }, ON_THE_CODE));

    expect(readable(code + shop)).not.toContain("In use");
    expect(primaryIn(code)).toStrictEqual(["/docs/quickstart"]);
    expect(primaryIn(shop)).toStrictEqual(["/woocommerce"]);
  });

  it("marks the code for a merchant whose imported products wait off sale", () => {
    const [code] = waysIn(drawn({ kind: "none" }, { through: "api", offSale: ["itm_1"] }));

    expect(readable(code)).toContain("In use");
  });

  it("says it could not read the way rather than marking none as if none were chosen", () => {
    const html = drawn(connected("read_write"), { unread: true });

    expect(readable(html)).not.toContain("In use");
    expect(readable(html)).toContain("couldn't be read");
  });
});

describe("the WooCommerce block on the integrations screen", () => {
  it("leads to no shop screen when the connection could not be read, since that screen needs the same read", () => {
    const html = drawn({ kind: "unread" }, ON_THE_CODE);

    expect(readable(html)).toContain("couldn't check your shop connection");
    expect(html).not.toContain('href="/woocommerce"');
    expect(html).toContain('href="/integrations"');
    // The SDK's way in does not depend on the shops table.
    expect(html).toContain('href="/docs/quickstart"');
  });

  it("says a grant narrower than read and write is not a working connection, and nothing of the kind over a full one", () => {
    const [, narrow] = waysIn(drawn(connected("read"), ON_THE_SHOP));
    const [, full] = waysIn(drawn(connected("read_write"), ON_THE_SHOP));

    expect(readable(narrow)).toContain("didn't grant Read/Write access");
    expect(readable(narrow)).not.toContain("Connected");
    expect(readable(narrow)).toContain("Connect again");
    expect(readable(full)).toContain("Connected");
    expect(readable(full)).not.toMatch(/read-only/i);
  });

  it("draws no block at all where this dashboard keeps no connection", () => {
    const text = readable(renderToString(<IntegrationsScreen view={integrationsView()} base="" />));

    expect(text).not.toContain("WooCommerce");
    expect(text).toContain("Your own code");
  });
});
