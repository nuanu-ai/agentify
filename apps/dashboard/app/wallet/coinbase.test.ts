// @vitest-environment jsdom

/**
 * Coinbase Wallet's provider as the dashboard opens it, in a document. The
 * promise is to the merchant: opening it starts none of Coinbase's analytics
 * in Agentify's page. By default the SDK starts them by inserting a script of
 * Coinbase's into the page, so the test watches the document for any script
 * put into it, including one removed again at once.
 */

import { describe, expect, it } from "vitest";
import { coinbaseWallet } from "./coinbase.js";

describe("Coinbase Wallet in Agentify's page", () => {
  it("puts no script of Coinbase's into the page when it is opened", () => {
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
