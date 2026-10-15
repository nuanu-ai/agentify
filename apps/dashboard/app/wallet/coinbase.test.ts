// @vitest-environment jsdom

/**
 * Coinbase Wallet's provider as the dashboard opens it, in a document. The
 * promise is to the merchant: opening it starts none of Coinbase's analytics
 * in Agentify's page. By default the SDK starts them by inserting a script of
 * Coinbase's into the page, so the test watches the document for any script
 * put into it, including one removed again at once.
 *
 * The SDK asks the page's own address for its headers as it starts, which in
 * this document is a port on this machine another program may be serving, so
 * the test answers that request itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { coinbaseWallet } from "./coinbase.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Coinbase Wallet in Agentify's page", () => {
  it("puts no script of Coinbase's into the page when it is opened", () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const watching = new MutationObserver(() => undefined);
    watching.observe(document, { childList: true, subtree: true });

    coinbaseWallet(84532);

    const inserted = watching
      .takeRecords()
      .flatMap((record) => [...record.addedNodes])
      .filter((node) => node.nodeName === "SCRIPT");
    watching.disconnect();
    expect(inserted).toEqual([]);
  });
});
