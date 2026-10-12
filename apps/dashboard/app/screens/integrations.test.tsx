/**
 * What the integrations screen says about a WooCommerce connection, drawn as
 * the server sends it. The states come from the shop's own rows, so each is
 * built here as the read hands it over; the HTTP tests walk the reads.
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { integrationsView } from "../../src/integrations-view.js";
import { readable } from "../../src/testing/html.js";
import type { ShopTile } from "../../src/woo-screens.js";
import { IntegrationsScreen } from "./integrations.js";

const SHOP = "https://shop.example";

const drawn = (shop: ShopTile | undefined): string =>
  renderToString(<IntegrationsScreen view={integrationsView(shop)} base="" />);

const connected = (permissions: string): ShopTile => ({
  kind: "connected",
  shop: { shopUrl: SHOP, permissions, connectedAt: new Date("2026-08-26T12:00:00Z") },
});

describe("the WooCommerce block on the integrations screen", () => {
  it("leads nowhere when the connection could not be read, since the shop screen needs the same read", () => {
    const html = drawn({ kind: "unread" });

    expect(readable(html)).toContain("could not be read just now");
    expect(html).not.toContain('href="/woocommerce"');
    // The SDK's way in does not depend on the shops table.
    expect(html).toContain('href="/docs/quickstart"');
  });

  it("names a grant narrower than read and write, and says nothing of the kind over a full one", () => {
    const narrow = readable(drawn(connected("read")));
    const full = readable(drawn(connected("read_write")));

    expect(narrow).toContain("Your shop granted read access rather than read and write");
    expect(full).toContain(`${SHOP}, connected 2026-08-26 12:00:00 UTC`);
    expect(full).not.toContain("rather than read and write");
  });

  it("draws no block at all where this dashboard keeps no connection", () => {
    const text = readable(drawn(undefined));

    expect(text).not.toContain("WooCommerce");
    expect(text).toContain("from your own code through the SDK.");
  });
});
