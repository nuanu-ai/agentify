/**
 * The commands that look after the merchants there are and their keys.
 *
 * The one thing worth more than the rest: nothing here makes a merchant or
 * issues a key. A merchant comes into being when a person opens the link mailed
 * to them and presses the cabinet's one control (ADR-0014), and a key for a
 * merchant's own code is issued from their cabinet, where it is announced
 * (ADR-0019). So every merchant and key below is arranged through the store and
 * the gateway's own functions, the way a registration or the keys route writes
 * them, and never through the command under test.
 *
 * The rest is what somebody does at a terminal: naming a merchant who is not
 * there, disabling a key twice, running a verb with half its arguments.
 */

import { describe, expect, it } from "vitest";
import { MemoryStore } from "./adapters/memory/store.js";
import { issueCabinetKey, issueKey } from "./app/merchants.js";
import { runMerchant } from "./merchant-command.js";
import { countedIds } from "./testing/harness.js";

/** A store, the identifiers, a fixed clock, and everything the command said. */
function aTerminal() {
  const store = new MemoryStore(countedIds());
  const said: string[] = [];
  const at = Date.parse("2026-08-27T12:00:00.000Z");
  // One generator across every write, because that is what a process has: two
  // of them would issue two keys under one identifier, which a database
  // refuses.
  const ids = countedIds();
  const run = (...argv: string[]) =>
    runMerchant(
      argv,
      store,
      () => at,
      (line) => said.push(line),
    );
  /** A merchant, written the way a registration writes one. */
  const aMerchant = async (name: string): Promise<string> => {
    const made = await store.addMerchant({ id: ids("mch"), name }, at);
    if (made === null) {
      throw new Error(`the store would not make ${name}`);
    }
    return made.id;
  };
  /** A key for the merchant's own code, issued the way the keys route issues one. */
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
    // The list is what somebody at a terminal reads to find a merchant, and the
    // name that identifies one to everybody else is the name their products are
    // sold under. A merchant who registered has no name of their own worth
    // printing — nobody typed one — so a list that showed only that column
    // would read identically down every row of them.
    const terminal = aTerminal();
    const merchantId = await terminal.aMerchant("Someone's shop");
    await terminal.run("listed-as", merchantId, "The shop on the corner");

    const listed = await theListing(terminal);

    expect(listed).toContain("The shop on the corner");
  });

  it("still names a merchant who has chosen none, rather than leaving the row blank", async () => {
    // The other half. A merchant with no listing name is the ordinary state
    // between registering and choosing, and their row still has to say which
    // merchant it is — otherwise the change above would have replaced one name
    // with nothing at all for every merchant who has not chosen yet.
    const terminal = aTerminal();
    await terminal.aMerchant("Someone's shop");

    const listed = await theListing(terminal);

    expect(listed).toContain("Someone's shop");
  });
});

/**
 * What `list` alone printed.
 *
 * Read off the lines this one run added rather than off everything the terminal
 * has ever said: the verb that sets a listing name prints that name back, so a
 * test reading the whole transcript would find it there and pass against a
 * listing that shows nothing of the sort.
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

  it("shows the keys a cabinet holds beside the merchant's own, and says which", async () => {
    // This list is the operator's and it is the only place either kind is
    // printed. Two things ride on it. A cabinet's key opens the door, so a
    // listing that left it out would let somebody revoke the merchant's last
    // worker believing they had another; and which key is which is what stands
    // between revoking a worker and locking a person out of their cabinet, so
    // it is said in a column rather than left to a label anybody can type.
    const terminal = aTerminal();
    const merchantId = await terminal.aMerchant("Someone's shop");
    await terminal.aKey(merchantId, "the worker's");
    await issueCabinetKey(terminal.store, terminal.ids, merchantId, terminal.at, "test");

    expect(await terminal.run("keys", merchantId)).toBe(0);

    expect(terminal.text()).toContain("own code");
    expect(terminal.text()).toContain("cabinet");
  });

  it("says which of a merchant's keys anything is still calling with", async () => {
    // The operator's question about a key is the merchant's question about
    // theirs — is anything still calling with this — and here it is asked about
    // the one kind that is on no merchant's screen: the key a cabinet signs in
    // with. A cabinet that stopped signing in weeks ago is a fact somebody
    // wants before they clear anything away, and this list is the only place it
    // can be read.
    //
    // The call is put on a different day from the one the keys were made on, so
    // that a line printing the wrong instant in the right place cannot pass.
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
    // And the blank claims a missing record rather than an absent call. The
    // same word is wrong here for a worse reason than on a merchant's screen:
    // the row somebody clears away on the strength of "never called" can be the
    // key a person's cabinet signs in with, and the gateway checked no such
    // thing — it wrote down the calls it saw, and a key older than the writing
    // looks exactly like this one.
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
    expect((await terminal.store.keysOf(merchantId))[0]?.disabledAt).toBe(terminal.at);
    // And the other one is untouched, which is the whole reason a key is a row.
    expect(second?.disabledAt).toBeNull();

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
    // The whole point of holding it here: the catalog drops what it cannot
    // render and tells nobody, so a merchant would trade under a word they did
    // not choose and never find out.
    const terminal = aTerminal();
    const merchantId = await terminal.aMerchant("A merchant");

    const code = await terminal.run("listed-as", merchantId, "Кафе");

    expect(code).toBe(1);
    expect(terminal.text()).toMatch(/ASCII/i);
    expect((await terminal.store.merchantById(merchantId))?.serviceName).toBeNull();
  });

  it("takes it away when nothing is named, and says the cards come off sale with it", async () => {
    // What the verb now does, and the person running it has to be told: a card
    // sells only under a name, because that name is what the payment request
    // calls the seller. So `--none` is not merely a row edited — it is this
    // merchant's whole catalog off sale, and somebody who reads "nothing about
    // the seller goes out" and walks away has been told the small half of it.
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
  // A merchant comes into being one way: a person opens the link mailed to
  // their address and presses the cabinet's one control (ADR-0014), and a key
  // for a merchant's own code is issued from their cabinet, where it is
  // announced (ADR-0019). The terminal looks after what exists and makes
  // neither.
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
    // A change of the wallet waits and is announced before anything is written
    // (ADR-0019), which holds only while the gateway sees every change. A verb
    // here that wrote it would be the one change nobody was told about.
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
