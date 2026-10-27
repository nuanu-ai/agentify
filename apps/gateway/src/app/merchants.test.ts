/**
 * Making a merchant, issuing a key, and seeding the sandbox with one.
 *
 * The subject here is the three things that would otherwise fail silently. A
 * key hashed one way when it is issued and another way at the door is a bug
 * that looks like a wrong key rather than like two hashes. A secret readable
 * from anywhere but the moment of issue is a key somebody can spend out of a
 * copy of the table. And a seed that is not idempotent is a sandbox that either
 * issues a key on every restart or, worse, quietly puts back one somebody
 * revoked on purpose.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../adapters/memory/store.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../split/networks.js";
import { countedIds } from "../testing/harness.js";
import {
  issueKey,
  keyDigest,
  NewKeyLabelSchema,
  newKeySecret,
  registerMerchant,
  SEEDED_MERCHANT,
  seedSandboxKey,
  setServiceName,
} from "./merchants.js";

const entropy = vi.hoisted(() => ({ controlled: 0 }));
vi.mock("node:crypto", async (original) => {
  const native = await original<typeof import("node:crypto")>();
  return {
    ...native,
    randomBytes: (size: number) => {
      if (!entropy.controlled) return native.randomBytes(size);
      if (size !== 32) throw new Error("a merchant key requires 32 native random bytes");
      return Buffer.from(
        entropy.controlled === 1
          ? "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
          : "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100",
        "hex",
      );
    },
  };
});

const aStore = () => new MemoryStore(NETWORK.network, countedIds());

/** The test chain's payout split, which a wallet set here is recorded with. */
const NETWORK = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");

describe("the name a seeded merchant is listed under", () => {
  it("keeps the live seed unnamed until a merchant chooses a listing name", async () => {
    const store = new MemoryStore(NETWORK.network, countedIds());
    const seeded = await seedSandboxKey(store, countedIds(), "csk_live_a-key", 0, "live");

    expect(seeded).toEqual({ kind: "issued", merchantId: "the_merchant", listedAs: null });
    expect((await store.merchantById("the_merchant"))?.serviceName).toBeNull();
  });

  it("lists a test seed as what it is", async () => {
    const store = new MemoryStore(NETWORK.network, countedIds());
    await seedSandboxKey(store, countedIds(), "csk_test_a-key", 0, "test");

    expect((await store.merchantById("the_merchant"))?.serviceName).toBe("Agentify test site");
  });
});

describe("a key", () => {
  it("encodes all 32 native random bytes in the issued key", () => {
    entropy.controlled = 1;
    try {
      expect(newKeySecret("test")).toBe("csk_test_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
      entropy.controlled = 2;
      expect(newKeySecret("test")).toBe("csk_test_Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA");
    } finally {
      entropy.controlled = 0;
    }
  });

  it("issues a key carrying the prefix of its environment", () => {
    expect(newKeySecret("test").startsWith("csk_test_")).toBe(true);
    expect(newKeySecret("live").startsWith("csk_live_")).toBe(true);
  });

  it("hashes and looks up a key exactly as it did before", () => {
    // The digest stays the SHA-256 of the whole secret, prefix included:
    // changing it would quietly break every key already issued.
    const secret = newKeySecret("test");
    expect(keyDigest(secret)).toBe(createHash("sha256").update(secret, "utf8").digest("hex"));
    expect(keyDigest(secret)).toHaveLength(64);
  });

  it("is stored as a digest and never comes back out", async () => {
    // The promise a copy of the table rests on: what is kept is not a key
    // anybody can spend, and nobody — us included — can read one back.
    const store = aStore();
    await store.addMerchant({ id: "mch_1", name: "A merchant" }, 1_000);

    const issued = await issueKey(store, countedIds(), "mch_1", "the worker's", 1_000, "test");

    expect(JSON.stringify(issued.key)).not.toContain(issued.secret);
    expect((await store.workingKey(keyDigest(issued.secret)))?.merchantId).toBe("mch_1");
    // And the key itself is not what anything is looked up by.
    expect(await store.workingKey(issued.secret)).toBeNull();
  });
});

describe("the label a key is issued under", () => {
  // A merchant tells keys apart by their labels when they come to revoke one,
  // and on the live deployment the message about a new key names it by its
  // label, so the label has to be one readable line.
  const refusal = (label: string): string =>
    NewKeyLabelSchema.safeParse(label).error?.issues[0]?.message ?? "taken";

  it("takes a label of up to a hundred characters, in any alphabet", () => {
    expect(NewKeyLabelSchema.safeParse("the shop's own worker").success).toBe(true);
    expect(NewKeyLabelSchema.safeParse("рабочий магазина").success).toBe(true);
    expect(NewKeyLabelSchema.safeParse("k".repeat(100)).success).toBe(true);
  });

  it("refuses a label nobody could tell from another, in words", () => {
    for (const label of ["", " ", "the worker "]) {
      const parsed = NewKeyLabelSchema.safeParse(label);
      expect(parsed.success, JSON.stringify(label)).toBe(false);
      expect(parsed.error?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "invalid_format", message: expect.stringMatching(/\S/) }),
        ]),
      );
    }
  });

  it("refuses a label longer than a hundred characters, in words", () => {
    expect(refusal("k".repeat(101))).toContain("100");
  });

  it("refuses a label that is more than one line, in words", () => {
    // A line break in a label would put a paragraph of somebody else's words
    // inside a message Agentify sends.
    for (const label of ["the stock\nworker", "the stock\r\nworker", "the stock\tworker"]) {
      const parsed = NewKeyLabelSchema.safeParse(label);
      expect(parsed.success, JSON.stringify(label)).toBe(false);
      expect(parsed.error?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "invalid_format", message: expect.stringMatching(/\S/) }),
        ]),
      );
    }
  });
});

describe("seeding the sandbox", () => {
  it("makes the merchant and the key on a database that has neither", async () => {
    const store = aStore();

    const seeded = await seedSandboxKey(store, countedIds(), "the-sandbox-key", 1_000, "sandbox");

    expect(seeded).toStrictEqual({
      kind: "issued",
      merchantId: SEEDED_MERCHANT.id,
      listedAs: "Agentify sandbox",
    });
    expect((await store.merchantById(SEEDED_MERCHANT.id))?.serviceName).toBe("Agentify sandbox");
    expect((await store.workingKey(keyDigest("the-sandbox-key")))?.merchantId).toBe(
      SEEDED_MERCHANT.id,
    );
  });

  it("writes nothing the second time, so a restart is not a second key", async () => {
    // A restart and a second replica both run this. A seed that issued again
    // would leave a merchant with a key per boot, none of which anybody
    // remembers making.
    const store = aStore();
    const ids = countedIds();
    await seedSandboxKey(store, ids, "the-sandbox-key", 1_000, "sandbox");

    const again = await seedSandboxKey(store, ids, "the-sandbox-key", 2_000, "sandbox");

    expect(again).toStrictEqual({ kind: "already_there" });
    expect(await store.keysOf(SEEDED_MERCHANT.id)).toHaveLength(1);
  });

  it("leaves a name somebody chose alone when it issues a key beside it", async () => {
    // The other way a start can issue a key: the same database with a new
    // string in SANDBOX_MERCHANT_KEY. The default belongs to a merchant nobody
    // has named, and this one is named, so the run says it listed nothing.
    const store = aStore();
    const ids = countedIds();
    await seedSandboxKey(store, ids, "the-sandbox-key", 1_000, "sandbox");
    await setServiceName(store, SEEDED_MERCHANT.id, "Someone's shop", 2_000);

    const seeded = await seedSandboxKey(store, ids, "another-sandbox-key", 3_000, "sandbox");

    expect(seeded).toStrictEqual({
      kind: "issued",
      merchantId: SEEDED_MERCHANT.id,
      listedAs: null,
    });
    expect((await store.merchantById(SEEDED_MERCHANT.id))?.serviceName).toBe("Someone's shop");
  });

  it("does not put back a listing name somebody took away", async () => {
    // A listing name that is missing on a database where the key is already
    // there is not a default waiting to be filled in: whoever cleared it in
    // the database chose to take the sandbox out of a catalogue, and a choice a
    // restart undoes is not a choice. This is the next boot.
    const store = aStore();
    const ids = countedIds();
    await seedSandboxKey(store, ids, "the-sandbox-key", 1_000, "sandbox");
    await store.setServiceName(SEEDED_MERCHANT.id, null, 2_000);

    const again = await seedSandboxKey(store, ids, "the-sandbox-key", 3_000, "sandbox");

    expect(again).toStrictEqual({ kind: "already_there" });
    expect((await store.merchantById(SEEDED_MERCHANT.id))?.serviceName).toBeNull();
  });

  it("leaves a key somebody disabled disabled, and says so", async () => {
    // Revoking a key must not be a thing a restart undoes. It is also why the
    // seed reads the key in whatever state it is in rather than through the
    // door's own lookup, which answers nothing for a disabled key — through
    // that, this would issue a second key with a digest already taken.
    const store = aStore();
    const ids = countedIds();
    await seedSandboxKey(store, ids, "the-sandbox-key", 1_000, "sandbox");
    const [key] = await store.keysOf(SEEDED_MERCHANT.id);
    if (key === undefined) throw new Error("the seed wrote no key");
    await store.disableKeyOf(SEEDED_MERCHANT.id, key.id, 2_000);

    const again = await seedSandboxKey(store, ids, "the-sandbox-key", 3_000, "sandbox");

    expect(again).toStrictEqual({ kind: "disabled" });
    expect(await store.keysOf(SEEDED_MERCHANT.id)).toHaveLength(1);
    expect(await store.workingKey(keyDigest("the-sandbox-key"))).toBeNull();
  });

  it("leaves the listing alone on the boot after the key was disabled", async () => {
    // Shutting the sandbox down is two commands — disable the key, take the
    // listing away — and neither half may come back by itself. This is the
    // second half on the path where the key is there and revoked.
    const store = aStore();
    const ids = countedIds();
    await seedSandboxKey(store, ids, "the-sandbox-key", 1_000, "sandbox");
    const [key] = await store.keysOf(SEEDED_MERCHANT.id);
    if (key === undefined) throw new Error("the seed wrote no key");
    await store.disableKeyOf(SEEDED_MERCHANT.id, key.id, 2_000);
    await store.setServiceName(SEEDED_MERCHANT.id, null, 2_000);

    const again = await seedSandboxKey(store, ids, "the-sandbox-key", 3_000, "sandbox");

    expect(again).toStrictEqual({ kind: "disabled" });
    expect((await store.merchantById(SEEDED_MERCHANT.id))?.serviceName).toBeNull();
  });

  it("survives two processes seeding the same key at the same instant", async () => {
    // Both read no key and both write one, and the digest is unique — so the
    // database refuses one of them. Left to propagate, that refusal takes the
    // losing process down at start-up with an error about a database that did
    // not answer, which is the one thing that had not gone wrong.
    const store = aStore();
    const ids = countedIds();

    const [first, second] = await Promise.all([
      seedSandboxKey(store, ids, "the-sandbox-key", 1_000, "sandbox"),
      seedSandboxKey(store, ids, "the-sandbox-key", 1_000, "sandbox"),
    ]);

    expect([first.kind, second.kind].sort()).toStrictEqual(["already_there", "issued"]);
    expect(await store.keysOf(SEEDED_MERCHANT.id)).toHaveLength(1);
    expect((await store.workingKey(keyDigest("the-sandbox-key")))?.merchantId).toBe(
      SEEDED_MERCHANT.id,
    );
  });

  it("throws when the write failed for a reason that is not a race", async () => {
    // The seed catches only that race. A store that cannot write is a
    // start-up failure somebody has to see, and swallowing it would leave a
    // gateway up with a key that opens nothing.
    const store = aStore();
    const broken = {
      ...store,
      addMerchant: store.addMerchant.bind(store),
      // The merchant row and the listing are the real store's, so this stays a
      // test about the key write. The key write fails before the listing is
      // reached, so a start-up failure leaves the sandbox listed as it was.
      merchantById: store.merchantById.bind(store),
      setServiceName: store.setServiceName.bind(store),
      keyByDigest: async () => null,
      addKey: async () => {
        throw new Error("the disk is full");
      },
    } as unknown as MemoryStore;

    await expect(
      seedSandboxKey(broken, countedIds(), "the-sandbox-key", 1_000, "sandbox"),
    ).rejects.toThrow("the disk is full");
  });

  it("does not put a merchant who had paused back on sale", async () => {
    // The seed runs on every boot, and the selling word is the merchant's own.
    // A seed that reset it would be a restart that started selling on somebody
    // else's behalf.
    const store = aStore();
    const ids = countedIds();
    await seedSandboxKey(store, ids, "the-sandbox-key", 1_000, "sandbox");
    await store.setSelling(SEEDED_MERCHANT.id, "paused");

    await seedSandboxKey(store, ids, "the-sandbox-key", 2_000, "sandbox");

    expect(await store.selling(SEEDED_MERCHANT.id)).toBe("paused");
  });
});

describe("registering a merchant", () => {
  it("makes the merchant and no key", async () => {
    // A key is issued when the merchant asks for one, from their dashboard,
    // which is where they are after registering: the account the dashboard
    // writes the merchant onto is the way in, not a key. So the new merchant's
    // list of keys is empty, which is the first thing their keys screen draws.
    const store = aStore();

    const made = await registerMerchant(store, countedIds(), 1_000);

    expect(await store.merchantById(made?.id ?? "")).not.toBeNull();
    expect(await store.keysOf(made?.id ?? "")).toStrictEqual([]);
    expect(made?.serviceName).toBeNull();
  });

  it("gives every registration its own merchant", async () => {
    const store = aStore();
    const ids = countedIds();

    const first = await registerMerchant(store, ids, 1_000);
    const second = await registerMerchant(store, ids, 2_000);

    expect(first?.id).not.toBe(second?.id);
    expect((await store.merchants()).length).toBe(2);
  });
});

describe("the name a merchant is listed under", () => {
  // The promise: what a seller is called in a discovery catalog is a fact the
  // merchant owns, kept in the one place a merchant is kept, and it never
  // reaches the catalog in a shape the catalog would quietly cut down.

  it("refuses a name the catalog would cut down rather than writing it", async () => {
    // The measured behaviour of the catalog: a name outside printable ASCII or
    // longer than thirty-two characters is dropped without a word. A merchant
    // has to meet that here, where somebody is reading the answer.
    const store = aStore();
    await store.addMerchant({ id: "mch_1", name: "A merchant" }, 1_000);

    await expect(setServiceName(store, "mch_1", "x".repeat(33), 2_000)).rejects.toThrow(/32/);
    await expect(setServiceName(store, "mch_1", "Кафе", 2_000)).rejects.toThrow(/ASCII/i);
    expect((await store.merchantById("mch_1"))?.serviceName).toBeNull();
  });
});
