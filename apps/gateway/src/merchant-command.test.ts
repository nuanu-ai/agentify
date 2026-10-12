/**
 * The terminal commands that look after merchants and their keys. Nothing here
 * makes a merchant or issues a key: a merchant comes into being when a person
 * opens the link mailed to them and presses the dashboard's one control, and a
 * key is issued from the merchant's dashboard, where it is announced. So every
 * merchant and key below is arranged through the store and the gateway's own
 * functions, never through the command under test.
 */

import { describe, expect, it } from "vitest";
import { MemoryStore } from "./adapters/memory/store.js";
import { issueKey } from "./app/merchants.js";
import { runMerchant } from "./merchant-command.js";
import { countedIds } from "./testing/harness.js";

function aTerminal() {
  const store = new MemoryStore(countedIds());
  const said: string[] = [];
  const at = Date.parse("2026-08-27T12:00:00.000Z");
  // One generator across every write, as in a process: two would issue two
  // keys under one identifier, which a database refuses.
  const ids = countedIds();
  const run = (...argv: string[]) =>
    runMerchant(
      argv,
      store,
      () => at,
      (line) => said.push(line),
    );
  const aMerchant = async (name: string): Promise<string> => {
    const made = await store.addMerchant({ id: ids("mch"), name }, at);
    if (made === null) {
      throw new Error(`the store would not make ${name}`);
    }
    return made.id;
  };
  const aKey = async (merchantId: string, label: string): Promise<string> =>
    (await issueKey(store, ids, merchantId, label, at, "test")).secret;
  return { store, said, at, ids, run, aMerchant, aKey, text: () => said.join("\n") };
}

describe("the merchants there are", () => {
  it("says what the verbs are when it is given one it does not know", async () => {
    const terminal = aTerminal();

    expect(await terminal.run()).toBe(2);
    expect(await terminal.run("delete", "everything")).toBe(2);
    expect(terminal.text()).toContain("disable");
  });

  it("says there are none rather than printing nothing", async () => {
    const terminal = aTerminal();

    expect(await terminal.run("list")).toBe(0);
    expect(terminal.text()).toContain("no merchants");
  });

  it("shows what buyers read, for the merchants who have chosen it", async () => {
    // A registered merchant's own name is one nobody typed, so a list showing
    // only that column would read the same down every row; the name their
    // products are sold under is what identifies them.
    const terminal = aTerminal();
    const merchantId = await terminal.aMerchant("Someone's shop");
    await terminal.run("listed-as", merchantId, "The shop on the corner");

    const listed = await theListing(terminal);

    expect(listed).toContain("The shop on the corner");
  });

  it("still names a merchant who has chosen none, rather than leaving the row blank", async () => {
    // No listing name is the ordinary state between registering and choosing
    // one.
    const terminal = aTerminal();
    await terminal.aMerchant("Someone's shop");

    const listed = await theListing(terminal);

    expect(listed).toContain("Someone's shop");
  });
});

/**
 * What `list` alone printed. Not the whole transcript: the verb that sets a
 * listing name prints it back, so a test reading everything would pass against
 * a listing that shows nothing of the sort.
 */
async function theListing(terminal: ReturnType<typeof aTerminal>): Promise<string> {
  const before = terminal.said.length;
  expect(await terminal.run("list")).toBe(0);
  return terminal.said.slice(before).join("\n");
}

describe("listing a merchant's keys", () => {
  it("never prints a key back", async () => {
    // What is kept is a digest, and this is the command that would leak it if
    // anything did.
    const terminal = aTerminal();
    const merchantId = await terminal.aMerchant("Someone's shop");
    const secret = await terminal.aKey(merchantId, "the worker's");

    expect(await terminal.run("keys", merchantId)).toBe(0);

    expect(terminal.text()).not.toContain(secret);
    expect(terminal.text()).toContain("the worker's");
  });

  it("says which of a merchant's keys anything is still calling with", async () => {
    // The call is on a different day from the keys' creation, so a line
    // printing the wrong instant in the right place cannot pass.
    const terminal = aTerminal();
    const merchantId = await terminal.aMerchant("Someone's shop");
    await terminal.aKey(merchantId, "the worker's");
    await terminal.aKey(merchantId, "the one nobody calls");
    const [called] = await terminal.store.keysOf(merchantId);
    await terminal.store.noteKeyUse(called?.id ?? "", Date.parse("2026-08-29T09:30:00.000Z"));

    expect(await terminal.run("keys", merchantId)).toBe(0);

    const lineFor = (label: string) =>
      terminal.said.find((line) => line.includes(label)) ?? `no line for ${label}`;
    expect(lineFor("the worker's")).toContain("2026-08-29");
    expect(lineFor("the one nobody calls")).not.toContain("2026-08-29");
    // A blank claims a missing record, not an absent call: a key older than the
    // recording of calls looks exactly like this one.
    expect(lineFor("the one nobody calls")).not.toMatch(/never/i);
    expect(lineFor("the one nobody calls")).toMatch(/record/i);
  });
});

describe("disabling a key", () => {
  it("stops one key and says whether the merchant has another that works", async () => {
    // Somebody revoking a key that has leaked needs to know whether they have
    // just locked the merchant out of their own gateway.
    const terminal = aTerminal();
    const merchantId = await terminal.aMerchant("Someone's shop");
    await terminal.aKey(merchantId, "the first");
    await terminal.aKey(merchantId, "the second");
    const [first, second] = await terminal.store.keysOf(merchantId);

    expect(await terminal.run("disable", first?.id ?? "")).toBe(0);

    expect(terminal.text()).toContain("1 other key");
    // Read again: the rows taken before the command say nothing about what it
    // did.
    const after = await terminal.store.keysOf(merchantId);
    expect(after.find((key) => key.id === first?.id)?.disabledAt).toBe(terminal.at);
    expect(after.find((key) => key.id === second?.id)?.disabledAt).toBeNull();

    terminal.said.length = 0;
    await terminal.run("disable", second?.id ?? "");
    expect(terminal.text()).toContain("no working key");
  });

  it("says there is no such key rather than reporting a revocation that never happened", async () => {
    const terminal = aTerminal();

    expect(await terminal.run("disable", "mk_nobody")).toBe(1);
    expect(terminal.text()).toContain("nothing to disable");
  });

  it("asks for a key rather than disabling something it had to guess", async () => {
    expect(await aTerminal().run("disable")).toBe(2);
  });
});

describe("the name a merchant is listed under", () => {
  it("sets it and says what it now is", async () => {
    const terminal = aTerminal();
    const merchantId = await terminal.aMerchant("Someone's shop");

    const code = await terminal.run("listed-as", merchantId, "Someone's shop");

    expect(code).toBe(0);
    expect((await terminal.store.merchantById(merchantId))?.serviceName).toBe("Someone's shop");
    expect(terminal.text()).toContain("Someone's shop");
  });

  it("refuses a name the catalog would cut down, and says why", async () => {
    // The catalog silently drops what it cannot render, so a merchant would
    // trade under a word they did not choose and never find out.
    const terminal = aTerminal();
    const merchantId = await terminal.aMerchant("A merchant");

    const code = await terminal.run("listed-as", merchantId, "Кафе");

    expect(code).toBe(1);
    expect(terminal.text()).toMatch(/ASCII/i);
    expect((await terminal.store.merchantById(merchantId))?.serviceName).toBeNull();
  });

  it("takes it away when nothing is named, and says the cards come off sale with it", async () => {
    // A card sells only under a name, because the payment request names the
    // seller by it. So `--none` takes the merchant's whole catalog off sale, and
    // the person running it has to be told.
    const terminal = aTerminal();
    const merchantId = await terminal.aMerchant("A merchant");
    await terminal.run("listed-as", merchantId, "Freeland");

    const code = await terminal.run("listed-as", merchantId, "--none");

    expect(code).toBe(0);
    expect((await terminal.store.merchantById(merchantId))?.serviceName).toBeNull();
    expect(terminal.text()).toMatch(/off sale/i);
  });

  it("says there is no such merchant rather than writing a row for one", async () => {
    const terminal = aTerminal();

    const code = await terminal.run("listed-as", "mch_nobody", "Freeland");

    expect(code).toBe(1);
    expect(terminal.text()).toContain("mch_nobody");
  });

  it("asks for a merchant rather than guessing at one", async () => {
    const terminal = aTerminal();

    expect(await terminal.run("listed-as")).toBe(2);
    expect(terminal.text()).toContain("listed-as");
  });
});

describe("what the terminal does not make", () => {
  it("makes no merchant, and says what the verbs are", async () => {
    const terminal = aTerminal();

    expect(await terminal.run("add", "Someone's shop")).toBe(2);

    expect(await terminal.store.merchants()).toStrictEqual([]);
    expect(terminal.text()).toContain("disable");
  });

  it("issues no key, even for a merchant that exists", async () => {
    const terminal = aTerminal();
    await terminal.store.addMerchant({ id: "mch_1", name: "Someone's shop" }, terminal.at);

    expect(await terminal.run("key", "mch_1", "the shop's own worker")).toBe(2);

    expect(await terminal.store.keysOf("mch_1")).toStrictEqual([]);
    expect(terminal.text()).not.toContain("csk_");
  });
});

describe("the address a merchant is paid at", () => {
  it("is not written from a terminal, so every change reaches the call that announces it", async () => {
    // A wallet change waits and is announced before anything is written, which
    // holds only while the gateway sees every change; a verb here would be the
    // one change nobody was told about.
    const terminal = aTerminal();
    const merchantId = await terminal.aMerchant("A merchant");

    const code = await terminal.run(
      "pays-to",
      merchantId,
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    );

    expect(code).toBe(2);
    expect((await terminal.store.merchantById(merchantId))?.payoutWallet.address).toBeNull();
  });
});
