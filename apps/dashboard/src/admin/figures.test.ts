/**
 * The workspace's Overview, Money and Health as their services answer them,
 * over the real gateway on memory adapters and the operator's memory reader.
 * The promises: a figure whose read failed says so and is never a zero; a
 * zero comes from a read that found nothing; the payout is shown as the
 * command prints it or refused; Check now reaches out only from a fresh
 * sign-in and keeps no wallet address in what it hands the page. Coinbase and
 * the validator are stand-ins; nothing here reaches the network.
 */

import { generateKeyPairSync } from "node:crypto";
import {
  memoryOperatorReader,
  type OperatorFigures,
  type OperatorReader,
  type Reach,
} from "@agentify/gateway/operator";
import { type Harness, harness } from "@agentify/gateway/testing";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { Person } from "../dashboard-entry.js";
import { identityFor } from "../identity.js";
import { TEST_AUTH_SECRET } from "../testing/secrets.js";
import type { Operator } from "./access.js";
import {
  type CheckReach,
  chartOf,
  figuresFor,
  type HealthView,
  listingRowOf,
  type MoneyView,
  type OverviewView,
  payoutViewOf,
  periodIn,
} from "./figures.js";
import { memoryJournal } from "./journal.js";

const CHANNELS = {
  test: { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "https://x402.org/facilitator" },
  live: {
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  },
} as const;

/** A key of the shape Coinbase issues, made here and opening nothing. */
const A_SECRET = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const published = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return Buffer.concat([seed, published]).toString("base64");
})();

const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

const PERSON = { id: "acc_operator", email: "operator@example.com" } as unknown as Person;

const viewOf = <View>(outcome: { kind: string; view?: View }): View => {
  if (outcome.kind !== "view" || outcome.view === undefined) throw new Error("no page was drawn");
  return outcome.view;
};

/** A reader whose figures and splits fail, as a database that does not answer does. */
const failing = (real: OperatorReader): OperatorReader => {
  const broken = new Proxy({} as OperatorFigures, {
    get: () => async () => {
      throw new Error("the database did not answer");
    },
  });
  return {
    ...real,
    figures: broken,
    splits: {
      splits: async () => {
        throw new Error("the database did not answer");
      },
    },
  };
};

interface Served {
  readonly harnessed: Harness;
  readonly pages: ReturnType<typeof figuresFor>;
  readonly asked: { readonly posts: string[]; readonly validated: string[] };
}

async function served(
  options: Readonly<{
    channel?: keyof typeof CHANNELS;
    reader?: (real: OperatorReader) => OperatorReader;
    coinbase?: number;
    validated?: unknown;
  }> = {},
): Promise<Served> {
  const channel = CHANNELS[options.channel ?? "test"];
  const harnessed = await harness({
    ...channel,
    ...(options.channel === "live"
      ? { CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: A_SECRET }
      : {}),
  });
  const config = loadConfig({
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: TEST_AUTH_SECRET,
    ...channel,
    ...(options.channel === "live"
      ? { CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: A_SECRET }
      : {}),
  });
  const identity = identityFor(config, {
    rows: {
      dashboard_accounts: [],
      dashboard_sessions: [],
      dashboard_credentials: [],
      dashboard_verifications: [],
      dashboard_link_sends: [],
    },
  });
  const real = memoryOperatorReader(harnessed.store);
  const asked = { posts: [] as string[], validated: [] as string[] };
  const reach: CheckReach = {
    post: (async (url: string | URL | Request) => {
      asked.posts.push(String(url));
      return new Response("{}", { status: options.coinbase ?? 400 });
    }) as typeof fetch,
    listing: {
      catalog: async () => ({ items: [{ id: "itm_1" }] }),
      door: async () => ({ kind: "unreachable", why: "a stand-in door answers nobody" }),
      validate: async (resource) => {
        asked.validated.push(resource);
        return { kind: "answered", status: 200, body: options.validated ?? { valid: true } };
      },
    } satisfies Reach,
  };
  const pages = figuresFor(
    {
      config,
      identity,
      gateway: harnessed.gateway,
      reader: (options.reader ?? ((r) => r))(real),
      journal: memoryJournal(harnessed.store),
      accounts: identity,
      pressing: {
        now: () => new Date(harnessed.now()),
        googleEnabled: false,
        refused: async () => {},
      },
      now: () => new Date(harnessed.now()),
      shops: null,
    },
    reach,
    { AGENTIFY_SOURCE_REVISION: "ea229fdd5c1f" },
  );
  return { harnessed, pages, asked };
}

/** An operator who signed in `ago` milliseconds before the harness's clock. */
const operatorAt = (harnessed: Harness, ago = 0): Operator =>
  ({ person: PERSON, signedInAt: new Date(harnessed.now() - ago) }) as Operator;

const form = (fields: Record<string, string>) => {
  const made = new FormData();
  for (const [name, value] of Object.entries(fields)) made.set(name, value);
  return made;
};

describe("the overview", () => {
  it("says every figure could not be read when its read fails, and draws none as a zero", async () => {
    const { harnessed, pages } = await served({ channel: "live", reader: failing });

    const view = viewOf<OverviewView>(
      await pages.overview(operatorAt(harnessed), new URLSearchParams()),
    );

    expect(view.tiles.map((tile) => tile.figure)).toStrictEqual([null, null, null, null]);
    expect(view.chart.kind).toBe("unread");
    expect(view.funnel.kind).toBe("unread");
    expect(view.needsYou?.kind).toBe("unread");
    expect(view.worth.unread.length).toBeGreaterThan(0);
  });

  it("draws zeros from reads that succeeded and found nothing, on a channel nobody sold on", async () => {
    const { harnessed, pages } = await served({ channel: "live" });

    const view = viewOf<OverviewView>(
      await pages.overview(operatorAt(harnessed), new URLSearchParams()),
    );

    expect(view.tiles.map((tile) => tile.figure)).toStrictEqual(["0", "0", "0.00", "0.00"]);
    expect(view.chart.kind).toBe("read");
  });

  it("names a merchant with a seller name and a wallet who waits for admission on the live channel", async () => {
    // The harness admits its merchant on the live channel; withdrawn, it waits again.
    const { harnessed, pages } = await served({ channel: "live" });

    const admitted = viewOf<OverviewView>(
      await pages.overview(operatorAt(harnessed), new URLSearchParams()),
    ).needsYou;
    await harnessed.store.withdrawLiveApproval(harnessed.merchant.id);
    const waiting = viewOf<OverviewView>(
      await pages.overview(operatorAt(harnessed), new URLSearchParams()),
    ).needsYou;

    expect(admitted?.kind === "read" && admitted.value.of).toBe(0);
    expect(
      waiting?.kind === "read" && waiting.value.items.map((item) => item.merchantId),
    ).toStrictEqual([harnessed.merchant.id]);
  });

  it("asks nothing about admission on the test channel, which admits nobody", async () => {
    const { harnessed, pages } = await served({ channel: "test" });

    const view = viewOf<OverviewView>(
      await pages.overview(operatorAt(harnessed), new URLSearchParams()),
    );

    expect(view.needsYou).toBeNull();
  });
});

describe("money", () => {
  it("reads the period a query names, and the last thirty days for any other", () => {
    expect(periodIn(new URLSearchParams("period=7d"))).toBe("7d");
    expect(periodIn(new URLSearchParams("period=all"))).toBe("all");
    expect(periodIn(new URLSearchParams("period=365d"))).toBe("30d");
    expect(periodIn(new URLSearchParams())).toBe("30d");
  });

  it("shows the payout every recorded split takes, as the builder makes it", async () => {
    // The harness's merchant set a wallet, which recorded its split.
    const { harnessed, pages } = await served({ channel: "test" });

    const view = viewOf<MoneyView>(await pages.money(operatorAt(harnessed), new URLSearchParams()));

    const listed =
      view.payout.kind === "read" && view.payout.value.kind === "listed" ? view.payout.value : null;
    expect(listed?.parts).toHaveLength(1);
    expect(listed?.parts[0]?.pays.join(" ")).toContain(harnessed.merchant.wallet);
    expect(view.splits.kind === "read" && view.splits.value.count).toBe(1);
  });

  it("says how many splits waiting behind a wallet change the payout leaves out, so an absent split is not read as none", () => {
    const chain = { id: "eip155:84532", name: "Base Sepolia" };
    const listed = payoutViewOf({ kind: "listed", chain, splits: 0, waiting: 2, parts: [] });
    const none = payoutViewOf({ kind: "nothing_recorded", chain, waiting: 1 });

    expect(listed.kind === "listed" && listed.intro).toContain(
      "2 splits waiting behind a wallet change",
    );
    expect(none.kind === "said" && none.said).toContain("1 split waiting behind a wallet change");
  });

  it("says which products the listing check ran out of time before, never as passed", () => {
    const row = listingRowOf({
      kind: "checked",
      base: "https://agentify.example",
      checkedAt: Date.parse("2026-10-24T09:00:00.000Z"),
      resources: [],
      probes: 0,
      refused: [],
      unanswered: [],
      unchecked: ["itm_2", "itm_3"],
      passed: false,
    });

    expect(row.badge.tone).not.toBe("pass");
    expect(row.fact.join(" ")).toContain("itm_2, itm_3");
  });

  it("shows no transaction where the gateway would refuse to start on the splits, and says why", () => {
    const view = payoutViewOf({
      kind: "refused",
      why: "a recorded split is no longer what this code makes",
    });

    expect(view).toStrictEqual({
      kind: "said",
      badge: { tone: "fail", word: "Not shown" },
      said: "No payout is shown, because the gateway would refuse to start on these splits: a recorded split is no longer what this code makes.",
    });
  });

  it("says the figures and the splits could not be read when their reads fail", async () => {
    const { harnessed, pages } = await served({ reader: failing });

    const view = viewOf<MoneyView>(await pages.money(operatorAt(harnessed), new URLSearchParams()));

    expect(view.tiles.map((tile) => tile.figure)).toStrictEqual([null, null, null, null]);
    expect(view.splits.kind).toBe("unread");
    expect(view.chart.kind).toBe("unread");
  });
});

describe("health", () => {
  it("says the test channel is not backed up, by decision, and the live channel's backup is not measured", async () => {
    const test = await served({ channel: "test" });
    const live = await served({ channel: "live" });

    const backupOf = async (one: Served) =>
      viewOf<HealthView>(await one.pages.health(operatorAt(one.harnessed))).unseen.find(
        (row) => row.part === "Last backup",
      );

    expect((await backupOf(test))?.fact.join("")).toMatch(/not backed up, by decision/);
    expect((await backupOf(live))?.badge).toStrictEqual({ tone: "unknown", word: "Not measured" });
  });

  it("names the revision the build wrote, linked to its commit", async () => {
    const { harnessed, pages } = await served();

    const release = viewOf<HealthView>(await pages.health(operatorAt(harnessed))).read.find(
      (row) => row.part === "Release",
    );

    expect(release?.fact).toContainEqual({
      text: "ea229fd",
      href: "https://github.com/nuanu-ai/agentify/commit/ea229fdd5c1f",
      elsewhere: true,
    });
  });

  it("checks the facilitator key at a press from a fresh sign-in, and keeps its answer for the page", async () => {
    const { harnessed, pages, asked } = await served({ channel: "live", coinbase: 401 });

    const view = viewOf<HealthView>(
      await pages.check(operatorAt(harnessed), form({ check: "key" })),
    );
    const again = viewOf<HealthView>(await pages.health(operatorAt(harnessed)));

    expect(asked.posts).toHaveLength(1);
    const key = (shown: HealthView) => shown.read.find((row) => row.part === "Facilitator key");
    expect(key(view)?.badge).toStrictEqual({ tone: "fail", word: "Refused" });
    expect(key(again)?.badge).toStrictEqual({ tone: "fail", word: "Refused" });
  });

  it("asks for a fresh sign-in instead of checking anything from an old one", async () => {
    const { harnessed, pages, asked } = await served({ channel: "live" });

    const view = viewOf<HealthView>(
      await pages.check(operatorAt(harnessed, 60 * 60_000), form({ check: "key" })),
    );

    expect(view.stepUp).not.toBeNull();
    expect(asked.posts).toStrictEqual([]);
  });

  it("checks the listing at a press and hands the page no wallet address the validator said", async () => {
    const { harnessed, pages, asked } = await served({
      validated: { valid: false, errors: [`payTo ${WALLET} is not accepted`] },
    });

    const view = viewOf<HealthView>(
      await pages.check(operatorAt(harnessed), form({ check: "listing" })),
    );

    expect(asked.validated).toHaveLength(1);
    const listing = view.read.find((row) => row.part === "x402 validation");
    expect(listing?.badge.tone).toBe("fail");
    expect(JSON.stringify(view)).not.toContain(WALLET);
  });
});

describe("the chart of settled sales", () => {
  const day = (index: number, delivered: string, nodel = "0.00") => ({
    day: new Date(Date.UTC(2026, 8, 24 + index)).toISOString().slice(0, 10),
    delivered: { amount: delivered, count: delivered === "0.00" ? 0 : 1 },
    noDelivery: { amount: nodel, count: nodel === "0.00" ? 0 : 1 },
  });
  const sales = {
    readAt: Date.parse("2026-10-23T14:05:00.000Z"),
    undated: { amount: "0.00", count: 0 },
    days: Array.from({ length: 30 }, (_, index) =>
      day(index, index === 1 ? "0.00" : "10.00", index === 28 ? "8.00" : "0.00"),
    ),
  };

  it("says every day to a screen reader, a quiet day as nothing settled", () => {
    const chart = chartOf(sales, false);

    expect(chart.spoken).toHaveLength(30);
    expect(chart.spoken[1]).toBe("25 Sep: nothing settled");
    expect(chart.bars.find((bar) => bar.label.startsWith("25 Sep"))?.className).toBe("bar zero");
  });

  it("stacks the part paid with no delivery recorded on top of the delivered part", () => {
    const chart = chartOf(sales, true);

    const onThatDay = chart.bars.filter((bar) => bar.label.startsWith("22 Oct"));
    expect(onThatDay.map((bar) => bar.className)).toStrictEqual(["bar", "bar nodel"]);
    expect(onThatDay[1]?.label).toBe("22 Oct: 8.00 USD paid with no delivery recorded");
  });
});
