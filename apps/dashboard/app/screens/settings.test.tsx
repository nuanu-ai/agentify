// @vitest-environment jsdom

/**
 * What the settings screen says about the payout wallet and the operator's
 * approval, drawn from views built out of documents the contract's schemas
 * accept, so nothing is stubbed. Each page is drawn as the server sends it, and
 * the press on the wallet form alive in a document. The presses themselves are
 * driven over HTTP in `server.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SurfaceMode } from "@agentify/core";
import {
  merchantPayout,
  PAYOUT_SPLIT_NETWORKS,
  payoutSplitFor,
  payoutSplitNetworkOf,
  type RecordedPayoutSplit,
} from "@agentify/gateway";
import { checksummedAddressOf, PayoutWalletSchema } from "@nuanu-ai/agentify-contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { PayoutSplits } from "../../src/gateway.js";
import { type SettingsPress, settingsView } from "../../src/settings-view.js";
import { readable } from "../../src/testing/html.js";
import { TEST_AUTH_SECRET } from "../../src/testing/secrets.js";
import { WALLET_WORDS } from "../wallet/buttons.js";
import type { Wallet } from "../wallet/requests.js";
import { PayoutWalletPanel, SettingsScreen } from "./settings.js";

/**
 * Coinbase Wallet as the page meets it, standing in for Coinbase's window: a
 * window it opens names `account`, which the provider then remembers in the
 * page until it is disconnected; it is switched to a chain, keeps the batches
 * it sent and refuses one for a chain it is not on. `opened` is false where
 * the module that brings Coinbase Wallet cannot be opened at all, and the next
 * `holding` windows wait in `held` to be answered by hand, as a window left
 * open does, or a vanished one never is.
 */
const coinbase = vi.hoisted(() => ({
  opened: true,
  account: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
  remembered: null as readonly string[] | null,
  holding: 0,
  held: [] as Readonly<{ accept: (account?: string) => void; decline: () => void }>[],
  declines: undefined as string | undefined,
  breaks: undefined as string | undefined,
  chain: "0x2105",
  sent: [] as Readonly<{ chainId: string; calls: readonly unknown[] }>[],
}));

vi.mock("../wallet/coinbase.js", async () => {
  const requests = await import("../wallet/requests.js");
  const wallet: Wallet = {
    async disconnect() {
      coinbase.remembered = null;
    },
    async request({ method, params }) {
      if (method === coinbase.declines) throw { code: 4001, message: "User rejected the request." };
      if (method === coinbase.breaks) throw { code: -32603, message: "insufficient funds for gas" };
      if (method === "eth_requestAccounts") {
        if (coinbase.remembered !== null) return coinbase.remembered;
        if (coinbase.holding > 0) {
          coinbase.holding -= 1;
          return new Promise((resolve, reject) => {
            coinbase.held.push({
              accept: (account = coinbase.account) => resolve([account]),
              decline: () => reject({ code: 4001, message: "User rejected the request." }),
            });
          });
        }
        coinbase.remembered = [coinbase.account];
        return coinbase.remembered;
      }
      if (method === "wallet_switchEthereumChain") {
        coinbase.chain =
          (params?.[0] as { chainId: string } | undefined)?.chainId ?? coinbase.chain;
        return null;
      }
      if (method === "wallet_sendCalls") {
        const batch = params?.[0] as { chainId: string; calls: readonly unknown[] };
        if (batch.chainId !== coinbase.chain) throw { code: 4901, message: "Chain mismatch" };
        coinbase.sent.push(batch);
        return { id: "0x00b47c4" };
      }
      throw { code: 4200, message: `Unsupported method ${method}` };
    },
  };
  return {
    ...requests,
    coinbaseWallet: () => {
      if (!coinbase.opened) throw new Error("Failed to fetch dynamically imported module");
      return wallet;
    },
  };
});

/** Of the right shape, and obviously not a real address. */
const SHAPED = "0x0123456789abcdef0123456789abcdef01234567";
const WAITING = checksummedAddressOf("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");

/** Each channel as its deployment configures it. */
const CHANNELS: Readonly<Record<SurfaceMode, Record<string, string>>> = {
  sandbox: { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "sandbox:scripted" },
  test: { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "https://x402.org/facilitator" },
  live: {
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  },
};

const MERCHANT = "mch_0123456789abcdef0123456789abcdef";

const networkOf = (mode: SurfaceMode) =>
  payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, CHANNELS[mode].PAYMENT_NETWORK ?? "");

/** The split the gateway records for this merchant's wallet on the mode's chain. */
const splitOf = (mode: SurfaceMode, wallet: string): RecordedPayoutSplit => ({
  ...payoutSplitFor(networkOf(mode), MERCHANT, wallet),
  recordedAt: Date.parse("2026-08-26T12:00:00Z"),
});

/** The gateway's answer for a merchant paid at `wallet`, built by its own rule and builder. */
const splitsFor = (
  mode: SurfaceMode,
  wallet: string | null,
  {
    pending,
    toPayOut,
    tooMany,
  }: {
    readonly pending?: string;
    readonly toPayOut?: readonly RecordedPayoutSplit[];
    readonly tooMany?: number;
  } = {},
): PayoutSplits => {
  const network = networkOf(mode);
  const paidOut = toPayOut ?? (wallet === null ? [] : [splitOf(mode, wallet)]);
  return {
    rate: {
      commissionAllocation: network.commissionAllocation,
      totalAllocation: network.totalAllocation,
    },
    inForce: wallet === null ? null : splitOf(mode, wallet),
    pending: pending === undefined ? null : splitOf(mode, pending),
    payout:
      tooMany !== undefined
        ? { tooMany }
        : paidOut.length === 0
          ? null
          : merchantPayout(network, paidOut, PAYOUT_SPLIT_NETWORKS),
  };
};

/** The dashboard's configuration on each channel, which names its chain's pages and its wallet's chain. */
const configOn = (mode: SurfaceMode) =>
  loadConfig({
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: TEST_AUTH_SECRET,
    ...CHANNELS[mode],
  });

interface Looking {
  readonly mode?: SurfaceMode;
  readonly wallet?: string | null;
  readonly pending?: string;
  readonly liveApproval?: boolean;
  readonly press?: SettingsPress;
  /** The gateway's answer about the splits, where it is not the one the wallets give. */
  readonly splits?: PayoutSplits;
}

const viewOf = ({
  mode = "sandbox",
  wallet = null,
  pending,
  liveApproval,
  press,
  splits,
}: Looking) =>
  settingsView(
    mode,
    "owner@example.com",
    {
      sellerName: "Freeland",
      sellerSite: "https://freeland.example",
      payoutWallet: PayoutWalletSchema.parse({
        payout_wallet: wallet,
        pending:
          pending === undefined
            ? null
            : { payout_wallet: pending, takes_effect_at: "2026-08-28T12:00:00Z" },
      }),
      payoutSplits: splits ?? splitsFor(mode, wallet, pending === undefined ? {} : { pending }),
      addressPage: configOn(mode).addressPage,
      walletChain: configOn(mode).walletChain,
      ...(liveApproval === undefined ? {} : { liveApproval }),
    },
    press,
  );

/** Inside the gate, as the screen is, so a form that posts knows its address. */
const routed = (drawn: () => ReactElement) => {
  const Stub = createRoutesStub([
    { id: "routes/gate", path: "/", children: [{ path: "settings", Component: drawn }] },
  ]);
  return (
    <Stub
      initialEntries={["/settings"]}
      hydrationData={{ loaderData: { "routes/gate": { who: "owner@example.com" } } }}
    />
  );
};

const walletPanel = (looking: Looking): string =>
  renderToString(routed(() => <PayoutWalletPanel wallet={viewOf(looking).wallet} />));

const settingsPage = (looking: Looking): string =>
  renderToString(routed(() => <SettingsScreen view={viewOf(looking)} />));

const asCopied = (html: string): string => html.replaceAll(/<[^>]*>/g, "");

/** The text a person reads, with each address whole as it copies off the page. */
const shownText = (html: string): string => readable(html.replaceAll(/<\/?span[^>]*>/g, ""));

afterEach(() => {
  cleanup();
  Object.assign(coinbase, {
    opened: true,
    remembered: null,
    holding: 0,
    held: [],
    declines: undefined,
    breaks: undefined,
    chain: "0x2105",
    sent: [],
  });
});

describe("the payout wallet on the settings screen", () => {
  it("shows a saved address whole, so a merchant can check it against their wallet", () => {
    const html = walletPanel({ wallet: SHAPED });

    // No ellipsis for the middle: that is the one presentation under which a
    // wrong address and the right one look identical.
    expect(asCopied(html)).toContain(SHAPED);
    expect(html).not.toContain("…");
  });

  it("leaves no space inside the address, so copying it off the page pastes an address", () => {
    const copied = asCopied(walletPanel({ wallet: SHAPED }));
    const shown = copied.slice(copied.indexOf("0x"), copied.indexOf("0x") + SHAPED.length);

    expect(shown).toBe(SHAPED);
  });

  it("asks for the address and for nothing else", () => {
    // A second box is how a merchant would come to believe we ask for a key or
    // a recovery phrase. The hidden fields are the form's own marks.
    const html = walletPanel({ wallet: null });

    expect(html.match(/<input(?![^>]*type="hidden")[^>]*>/g)).toHaveLength(1);
    expect(html).toContain('name="payout_wallet"');
    expect(readable(html).toLowerCase()).not.toMatch(/enter your (private key|recovery phrase)/);
  });

  it("says a sandbox address is optional because nothing settles", () => {
    const text = readable(walletPanel({ wallet: null }));

    expect(text).toMatch(/does not settle/i);
    expect(text).toMatch(/optional/i);
  });

  it("says publishing is refused without an address where the door asks for one", () => {
    // Until an address is set, every card the merchant's code publishes is
    // refused, in test mode as in live; the sandbox asks for none.
    for (const mode of ["test", "live"] as const) {
      expect(readable(walletPanel({ wallet: null, mode })), mode).toMatch(
        /publishing a card is refused/i,
      );
    }
    expect(readable(walletPanel({ wallet: null }))).not.toMatch(/refused/i);
  });

  it("says nothing about a refusal once an address is set", () => {
    const text = readable(walletPanel({ wallet: SHAPED, mode: "test" }));

    expect(text).not.toMatch(/refused/i);
    expect(text).not.toMatch(/optional/i);
  });

  it("names Base Sepolia and test USDC on the test stack, and the share paid out to the wallet", () => {
    const text = readable(walletPanel({ wallet: null, mode: "test" }));

    expect(text).toContain("Base Sepolia");
    expect(text).toContain("test USDC");
    expect(text).toMatch(/your share of every test sale/i);
  });

  it("says a different address waits forty-eight hours only on live, where it does", () => {
    // Elsewhere a change applies at once, and a first address on live replaces
    // nothing, so nothing waits.
    expect(readable(walletPanel({ mode: "live", wallet: SHAPED }))).toMatch(/forty-eight hours/);
    for (const looking of [
      { mode: "sandbox", wallet: SHAPED },
      { mode: "test", wallet: SHAPED },
      { mode: "live", wallet: null },
    ] as const) {
      expect(readable(walletPanel(looking)), JSON.stringify(looking)).not.toMatch(
        /forty-eight hours/,
      );
    }
  });

  it("shows a refused address whole, so the merchant can read it against their wallet", () => {
    // On the page as text, not only inside the box: the box's value is an
    // attribute, which the clipboard's view of the page does not see.
    const shouted = `0x${SHAPED.slice(2).toUpperCase()}`;
    const html = walletPanel({
      wallet: SHAPED,
      press: { kind: "wallet", problem: "It was not saved.", typed: shouted },
    });

    expect(asCopied(html)).toContain(shouted);
  });

  it("shows what was wrong with an address just refused", () => {
    const html = walletPanel({
      wallet: SHAPED,
      press: { kind: "wallet", problem: "that was not saved", typed: "" },
    });

    expect(readable(html)).toContain("that was not saved");
  });
});

describe("a change of the payout wallet on its way", () => {
  /** The wallet form pressed in a live document; nothing leaves it. */
  const pressed = (looking: Looking): HTMLFormElement => {
    render(routed(() => <PayoutWalletPanel wallet={viewOf(looking).wallet} />));
    document.addEventListener("submit", (event) => event.preventDefault(), { once: true });
    const box = screen.getByLabelText(/payout wallet address/i);
    fireEvent.change(box, { target: { value: WAITING } });
    const form = box.closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    return form;
  };

  it("says on live that every account is told before it is recorded, so the wait does not look frozen", () => {
    const form = pressed({ mode: "live", wallet: SHAPED });

    const said = within(form).getByRole("status").textContent ?? "";
    expect(said).toMatch(/every account of your merchant is sent a message/i);
    expect(said).toMatch(/30 seconds/);
    expect(
      screen.getByRole("button", { name: "Change the address" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("says nothing of the kind where a change applies at once", () => {
    // Elsewhere, and for a first address on live, nobody is told first.
    for (const looking of [
      { mode: "test", wallet: SHAPED },
      { mode: "live", wallet: null },
    ] as const) {
      const form = pressed(looking);

      expect(within(form).queryByRole("status"), JSON.stringify(looking)).toBeNull();
      cleanup();
    }
  });

  it("is not served with the page, where no press has happened", () => {
    expect(readable(walletPanel({ mode: "live", wallet: SHAPED }))).not.toMatch(
      /is sent a message about a different address/,
    );
  });
});

describe("whether a live merchant is approved", () => {
  const settings = (looking: Looking): string =>
    readable(renderToString(routed(() => <SettingsScreen view={viewOf(looking)} />)));

  it("says on Settings whether Agentify has approved the merchant for live sales", () => {
    const approved = settings({ mode: "live", wallet: SHAPED, liveApproval: true });
    const waiting = settings({ mode: "live", wallet: SHAPED, liveApproval: false });

    expect(approved).toMatch(/approved your merchant/);
    expect(waiting).toMatch(/not approved your merchant/);
    expect(approved).not.toMatch(/not approved your merchant/);
  });

  it("says nothing about the approval off the live channel, where nobody needs it", () => {
    for (const mode of ["sandbox", "test"] as const) {
      expect(settings({ mode, wallet: SHAPED, liveApproval: false }), mode).not.toMatch(/approv/i);
    }
  });
});

/** A share of the payout split's total, formatted from the network's own terms. */
const percent = (part: number, whole: number): string => `${(part / whole) * 100}%`;

/** The terms of the Base Sepolia experiment's splits: 97% to the merchant and 3% to Agentify. */
const AT_THREE_PERCENT = { commissionAllocation: 30_000, totalAllocation: 1_000_000 } as const;

describe("the commission, before a merchant saves their first wallet", () => {
  // Saving the wallet on a screen that names the commission is the merchant's
  // consent to it, so it is said above the box, before anything is saved. It
  // covers a sale given back, since the merchant refunds the whole price and
  // the commission stays, and it says the contract pays nothing out by itself:
  // the payout panel that says so is drawn only once a wallet is saved.
  for (const mode of ["test", "live"] as const) {
    it(`names on ${mode} the rate, a refunded sale included, how it is taken, that the money waits for a payout, and that saving agrees to it, above the form`, () => {
      const network = networkOf(mode);
      const html = walletPanel({ mode, wallet: null });
      const beforeTheForm = readable(html.slice(0, html.indexOf("<form")));
      const commission = percent(network.commissionAllocation, network.totalAllocation);
      const share = percent(
        network.totalAllocation - network.commissionAllocation,
        network.totalAllocation,
      );

      expect(beforeTheForm).toContain(
        `Agentify keeps ${commission} of every sale, a refunded one included`,
      );
      expect(beforeTheForm).toMatch(/buyers pay into a payout contract made for this wallet/i);
      expect(beforeTheForm).toContain(
        `it pays ${share} to the wallet and ${commission} to Agentify, and nobody can change that`,
      );
      expect(beforeTheForm).toMatch(
        /the money waits in the contract until somebody pays it out: you, at any time, or Agentify, on no set date/i,
      );
      expect(beforeTheForm).toMatch(/saving a wallet here is your agreement/i);
      expect(html.indexOf('name="payout_wallet"')).toBeGreaterThan(html.indexOf("<form"));
    });
  }

  it("says the rate of the terms splits are recorded with, which a rate written into the screen would not follow", () => {
    // The Base Sepolia experiment's real terms, 97% and 3%, with the merchant's
    // split recorded at them: every percentage on the page has to be theirs.
    const network = { ...networkOf("test"), ...AT_THREE_PERCENT };
    const split = {
      ...payoutSplitFor(network, MERCHANT, SHAPED),
      recordedAt: Date.parse("2026-10-09T12:00:00Z"),
    };
    const text = readable(
      settingsPage({
        mode: "test",
        wallet: SHAPED,
        splits: {
          rate: AT_THREE_PERCENT,
          inForce: split,
          pending: null,
          payout: merchantPayout(network, [split], PAYOUT_SPLIT_NETWORKS),
        },
      }),
    );

    expect(text).toContain("Agentify keeps 3% of every sale");
    expect(text).toContain("it pays 97% to the wallet and 3% to Agentify");
    expect(text).not.toContain("99.9%");
    expect(text).not.toContain("0.1%");
  });

  it("says in the sandbox that nothing is deployed and no money moves", () => {
    const text = readable(walletPanel({ mode: "sandbox", wallet: null }));

    expect(text).toMatch(/Agentify keeps \S+% of every sale/);
    expect(text).toMatch(/in the sandbox nothing is deployed and no money moves/i);
    expect(readable(walletPanel({ mode: "test", wallet: null }))).not.toMatch(
      /nothing is deployed/,
    );
  });
});

describe("the payout contract buyers pay into", () => {
  const W = SHAPED;

  it("is shown whole beside the saved wallet, with a link to it on the test channel's explorer", () => {
    const split = splitOf("test", W).address;
    const html = walletPanel({ mode: "test", wallet: W });

    expect(asCopied(html)).toContain(split);
    expect(html).not.toContain("…");
    expect(html).toContain(`href="https://sepolia.basescan.org/address/${split}"`);
    // The wallet holds nothing that waits for a payout; the contract does.
    expect(html).not.toContain(`/address/${W}`);
  });

  it("links to Base's explorer on the live channel, never Base Sepolia's", () => {
    const split = splitOf("live", W).address;
    const html = walletPanel({ mode: "live", wallet: W });

    expect(html).toContain(`href="https://basescan.org/address/${split}"`);
    expect(html).not.toContain("sepolia.basescan.org");
  });

  it("is shown in the sandbox without a link, since nothing is ever deployed there", () => {
    const split = splitOf("sandbox", W).address;
    const html = walletPanel({ mode: "sandbox", wallet: W });

    expect(asCopied(html)).toContain(split);
    expect(html).not.toContain("basescan");
    expect(readable(html)).not.toMatch(/see what it holds/i);
  });

  it("names no contract beside a saved wallet the gateway recorded none for", () => {
    // A wallet without a recorded split is read as no wallet by the gateway;
    // the screen must not make one up.
    const html = walletPanel({
      mode: "test",
      wallet: W,
      splits: { ...splitsFor("test", W), inForce: null },
    });

    expect(asCopied(html)).toContain(W);
    expect(readable(html)).not.toMatch(/buyers pay into 0x/i);
  });

  it("is not shown beside a wallet it was not recorded for", () => {
    // Two reads that straddled a change: the screen names no contract rather
    // than one that pays another wallet.
    const html = walletPanel({ mode: "test", wallet: W, splits: splitsFor("test", WAITING) });

    expect(asCopied(html)).not.toContain(splitOf("test", WAITING).address);
  });

  it("shows a waiting wallet's contract beside the waiting wallet", () => {
    const html = walletPanel({ mode: "live", wallet: W, pending: WAITING });
    const waiting = html.slice(html.indexOf("Waiting to replace it"));

    expect(asCopied(waiting)).toContain(WAITING);
    expect(asCopied(waiting)).toContain(splitOf("live", WAITING).address);
  });
});

describe("the links into the money page", () => {
  /** Each heading's anchor, as the documentation site makes it from the heading. */
  const sections = new Set(
    [
      ...readFileSync(join(import.meta.dirname, "../../../docs/money.md"), "utf8").matchAll(
        /^#{2,3} (.+)$/gm,
      ),
    ].map(([, heading]) =>
      (heading ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    ),
  );

  it("each land on a section of it, from every state of the wallet", () => {
    const linked = new Set(
      [
        settingsPage({ mode: "test", wallet: null }),
        settingsPage({ mode: "test", wallet: SHAPED }),
        settingsPage({ mode: "live", wallet: SHAPED, pending: WAITING }),
      ].flatMap((html) => [...html.matchAll(/href="\/docs\/money#([^"]+)"/g)].map(([, at]) => at)),
    );

    expect(linked.size).toBeGreaterThan(2);
    expect([...linked].filter((at) => !sections.has(at ?? ""))).toStrictEqual([]);
  });
});

describe("the payout instruction", () => {
  const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

  /** What the box holding the data holds. */
  const dataIn = (html: string): string =>
    /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? "";

  it("gives Multicall3 as To, with words saying it is a public contract and not ours, and zero as Amount", () => {
    const text = shownText(settingsPage({ mode: "test", wallet: W }));

    expect(text).toContain(`To ${MULTICALL3}`);
    expect(text).toMatch(/Multicall3, a public contract, not ours/);
    expect(text).toMatch(/Amount 0\b/);
  });

  it("gives the whole data the builder makes for the merchant's recorded split, never cut", () => {
    const html = settingsPage({ mode: "test", wallet: W });
    const built = merchantPayout(
      networkOf("test"),
      [splitOf("test", W)],
      PAYOUT_SPLIT_NETWORKS,
    ).data;

    expect(dataIn(html)).toBe(built);
    expect(dataIn(html)).toHaveLength(3_146);
    expect(html).not.toContain("…");
  });

  it("puts the whole data on the clipboard and says so", async () => {
    let held = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          held = text;
        },
      },
    });
    render(routed(() => <SettingsScreen view={viewOf({ mode: "test", wallet: W })} />));

    await act(async () => {
      fireEvent.click(screen.getByText("Copy the data"));
    });

    expect(held).toBe(
      merchantPayout(networkOf("test"), [splitOf("test", W)], PAYOUT_SPLIT_NETWORKS).data,
    );
    const row = screen.getByText("Copy the data").closest("p") as HTMLElement;
    expect(within(row).getByRole("status").textContent).toBe("Copied.");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("names the one chain to send it on, Base Sepolia with test ETH on the test channel and Base on live", () => {
    // Multicall3 is at the same address on most chains, and sent on another
    // one the transaction can succeed, pay out nothing and still cost a fee.
    const onTest = readable(settingsPage({ mode: "test", wallet: W }));
    const onLive = readable(settingsPage({ mode: "live", wallet: W }));

    expect(onTest).toMatch(/send this transaction on Base Sepolia only/);
    expect(onTest).toMatch(/test ETH/);
    expect(onLive).toMatch(/send this transaction on Base only/);
    expect(onLive).not.toMatch(/Base Sepolia|test ETH/);
    expect(dataIn(settingsPage({ mode: "live", wallet: W }))).toBe(
      merchantPayout(networkOf("live"), [splitOf("live", W)], PAYOUT_SPLIT_NETWORKS).data,
    );
  });

  it("links to how to send it, and says that otherwise the merchant is paid on no set date", () => {
    // Whether a wallet shows a field for the data, and where, is the money
    // page's to say: it is written from what sending one shows.
    const html = settingsPage({ mode: "test", wallet: W });

    expect(html).toMatch(/<a href="\/docs\/money#getting-paid-out"[^>]*>How to send it<\/a>/);
    expect(readable(html)).toMatch(
      /Otherwise you are paid when Agentify next pays out every contract, on no set date/,
    );
  });

  it("is not drawn in the sandbox, where nothing is ever deployed", () => {
    const html = settingsPage({ mode: "sandbox", wallet: W });

    expect(html).not.toContain(MULTICALL3);
    expect(html).not.toContain("<textarea");
    expect(readable(html)).not.toMatch(/get your payout/i);
  });

  it("is not drawn where no split can hold the merchant's money", () => {
    const html = settingsPage({
      mode: "test",
      wallet: W,
      splits: { ...splitsFor("test", W), payout: null },
    });

    expect(html).not.toContain("<textarea");
    expect(readable(html)).not.toMatch(/get your payout/i);
  });

  it("is not drawn beside no saved wallet, even where the splits were read after one was saved", () => {
    const html = settingsPage({ mode: "test", wallet: null, splits: splitsFor("test", W) });

    expect(html).not.toContain(MULTICALL3);
    expect(html).not.toContain("<textarea");
  });

  it("is not drawn for a merchant with no wallet, on any channel", () => {
    for (const mode of ["sandbox", "test", "live"] as const) {
      const html = settingsPage({ mode, wallet: null });
      expect(html, mode).not.toContain(MULTICALL3);
      expect(html, mode).not.toContain("<textarea");
    }
  });

  it("names beside each contract it pays out the wallet that contract pays", () => {
    // After a change of wallet, an earlier contract may still hold money, and
    // it pays the wallet written into it, not the one in force now.
    const W1 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
    const earlier = splitOf("live", W1);
    const now = splitOf("live", W);
    const html = settingsPage({
      mode: "live",
      wallet: W,
      splits: splitsFor("live", W, { toPayOut: [earlier, now] }),
    });
    const pairs = [
      ...shownText(html).matchAll(/(0x[0-9a-fA-F]{40}) pays (0x[0-9a-fA-F]{40})/g),
    ].map((pair) => [pair[1], pair[2]]);
    const data = dataIn(html).toLowerCase();

    expect(pairs).toStrictEqual([
      [earlier.address, W1],
      [now.address, W],
    ]);
    expect(shownText(html)).toMatch(/each share arrives in the wallet beside its contract/);
    expect(shownText(settingsPage({ mode: "live", wallet: W }))).toMatch(
      /your share arrives in the same transaction/,
    );
    // Each wallet is the owner of a withdrawal in the data: `withdraw(owner, token)`.
    for (const [, wallet] of pairs) {
      expect(data).toContain(`f940e385${(wallet ?? "").slice(2).toLowerCase().padStart(64, "0")}`);
    }
  });

  it("says plainly where one transaction cannot pay out every contract, and that Agentify pays them out on no set date", () => {
    const html = settingsPage({
      mode: "test",
      wallet: W,
      splits: splitsFor("test", W, { tooMany: 21 }),
    });
    const text = readable(html);

    expect(text).toMatch(/21 payout contracts/);
    expect(text).toMatch(/You are paid when Agentify next pays out every contract, on no set date/);
    expect(html).not.toContain(MULTICALL3);
    expect(html).not.toContain("<textarea");
  });
});

describe("creating or connecting a Coinbase Wallet from the settings", () => {
  const CHECKSUMMED = checksummedAddressOf(coinbase.account);
  const button = () => screen.getByRole("button", { name: WALLET_WORDS.connect });
  const box = () => screen.getByLabelText("Payout wallet address") as HTMLInputElement;
  const press = async (control: HTMLElement) => {
    await act(async () => {
      fireEvent.click(control);
    });
    await waitFor(() => expect(screen.queryByText(WALLET_WORDS.waiting)).toBeNull());
  };

  it("is offered only once the page's script runs, so a page without script shows no button that does nothing", () => {
    expect(walletPanel({ mode: "test" })).not.toContain(WALLET_WORDS.connect);

    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "test" }).wallet} />));

    expect(button()).toBeTruthy();
  });

  it("is offered on the live channel as on the test channel", () => {
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));

    expect(button()).toBeTruthy();
  });

  it("is not offered in the sandbox, where no wallet is ever paid", () => {
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "sandbox" }).wallet} />));

    expect(screen.queryByRole("button", { name: WALLET_WORDS.connect })).toBeNull();
  });

  it("puts the wallet's address into the box in a wallet's spelling, and saves nothing until the merchant presses Save", async () => {
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "test" }).wallet} />));
    let submitted = false;
    box().form?.addEventListener("submit", () => {
      submitted = true;
    });
    const submits = [
      vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => undefined),
      vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined),
    ];

    await press(button());

    expect(box().value).toBe(CHECKSUMMED);
    expect(submitted).toBe(false);
    expect(submits.map((submit) => submit.mock.calls.length)).toEqual([0, 0]);
    for (const submit of submits) submit.mockRestore();
    expect(screen.getByText(WALLET_WORDS.addressInTheBox)).toBeTruthy();
  });

  it("leaves the box as the merchant left it when they close Coinbase's window", async () => {
    coinbase.declines = "eth_requestAccounts";
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "test" }).wallet} />));
    fireEvent.change(box(), { target: { value: "0x1234" } });

    await press(button());

    expect(box().value).toBe("0x1234");
    expect(screen.getByText(WALLET_WORDS.connectClosed)).toBeTruthy();
  });

  it("keeps the box for an address typed by hand when Coinbase Wallet cannot be opened", async () => {
    coinbase.opened = false;
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "test" }).wallet} />));
    fireEvent.change(box(), { target: { value: "0x1234" } });

    await press(button());

    expect(box().value).toBe("0x1234");
    expect(screen.getByText(WALLET_WORDS.connectFailed("the page could not open it"))).toBeTruthy();
  });

  it("takes a second press while the first is still unanswered, as when Coinbase's window vanished without a word", async () => {
    coinbase.holding = 1;
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "test" }).wallet} />));
    await act(async () => {
      fireEvent.click(button());
    });

    await press(button());

    expect(box().value).toBe(CHECKSUMMED);
    expect(screen.getByText(WALLET_WORDS.addressInTheBox)).toBeTruthy();
  });

  it("keeps what the latest press brought when an earlier press is answered after it", async () => {
    coinbase.holding = 1;
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "test" }).wallet} />));
    await act(async () => {
      fireEvent.click(button());
    });
    await press(button());

    await act(async () => {
      coinbase.held[0]?.accept("0x0000000000000000000000000000000000000bad");
    });

    expect(box().value).toBe(CHECKSUMMED);
    expect(screen.getByText(WALLET_WORDS.addressInTheBox)).toBeTruthy();
  });

  it("takes the refusal of an earlier address off the box it fills, so it is not read out against the new one", async () => {
    const refused = "That is not an address.";
    render(
      routed(() => (
        <PayoutWalletPanel
          wallet={
            viewOf({
              mode: "test",
              press: { kind: "wallet", problem: refused, typed: "0x1234" },
            }).wallet
          }
        />
      )),
    );
    expect(box().getAttribute("aria-invalid")).toBe("true");

    await press(button());

    expect(box().value).toBe(CHECKSUMMED);
    expect(box().getAttribute("aria-invalid")).toBeNull();
    expect(box().getAttribute("aria-describedby")).toBeNull();
    expect(screen.getByText(refused).hidden).toBe(true);
  });

  it("links to where the merchant manages the wallet and to how Coinbase recovers it", () => {
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "test" }).wallet} />));

    const links = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(links).toContain(WALLET_WORDS.manageAt);
    expect(links).toContain(WALLET_WORDS.recoveryAt);
  });
});

describe("sending the payout from a Coinbase Wallet", () => {
  const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const button = () => screen.getByRole("button", { name: WALLET_WORDS.payOut });
  const press = async () => {
    await act(async () => {
      fireEvent.click(button());
    });
    await waitFor(() => expect(screen.queryByText(WALLET_WORDS.waiting)).toBeNull());
  };

  it("is offered only once the page's script runs, beside the transaction it sends", () => {
    expect(settingsPage({ mode: "test", wallet: W })).not.toContain(WALLET_WORDS.payOut);

    render(routed(() => <SettingsScreen view={viewOf({ mode: "test", wallet: W })} />));

    expect(button()).toBeTruthy();
  });

  it("sends the transaction the screen shows, whole and carrying no money, on Base Sepolia for the test channel", async () => {
    render(routed(() => <SettingsScreen view={viewOf({ mode: "test", wallet: W })} />));

    await press();

    expect(coinbase.sent).toEqual([
      expect.objectContaining({
        chainId: "0x14a34",
        calls: [
          {
            to: "0xcA11bde05977b3631167028862bE2a173976CA11",
            value: "0x0",
            data: merchantPayout(networkOf("test"), [splitOf("test", W)], PAYOUT_SPLIT_NETWORKS)
              .data,
          },
        ],
      }),
    ]);
  });

  it("sends it on Base for the live channel", async () => {
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

    await press();

    expect(coinbase.sent.map((batch) => batch.chainId)).toEqual(["0x2105"]);
  });

  it("says the wallet sent it, not that the money has arrived", async () => {
    render(routed(() => <SettingsScreen view={viewOf({ mode: "test", wallet: W })} />));

    await press();

    expect(screen.getByText(WALLET_WORDS.payoutSent)).toBeTruthy();
  });

  it("sends nothing and says so when the merchant closes Coinbase's window", async () => {
    coinbase.declines = "wallet_sendCalls";
    render(routed(() => <SettingsScreen view={viewOf({ mode: "test", wallet: W })} />));

    await press();

    expect(coinbase.sent).toEqual([]);
    expect(screen.getByText(WALLET_WORDS.payoutClosed)).toBeTruthy();
  });

  it("says, when the wallet does not send it, that the payout then arrives with Agentify's", async () => {
    coinbase.breaks = "wallet_sendCalls";
    render(routed(() => <SettingsScreen view={viewOf({ mode: "test", wallet: W })} />));

    await press();

    expect(screen.getByText(WALLET_WORDS.payoutFailed("insufficient funds for gas"))).toBeTruthy();
  });

  it("takes a second press while the first is still unanswered, and says what it sent", async () => {
    coinbase.holding = 1;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "test", wallet: W })} />));
    await act(async () => {
      fireEvent.click(button());
    });

    await press();

    expect(coinbase.sent).toHaveLength(1);
    expect(screen.getByText(WALLET_WORDS.payoutSent)).toBeTruthy();
  });

  it("never says nothing was sent when an earlier press sends its payout after a later one was closed", async () => {
    coinbase.holding = 1;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "test", wallet: W })} />));
    await act(async () => {
      fireEvent.click(button());
    });
    coinbase.declines = "eth_requestAccounts";
    await press();
    coinbase.declines = undefined;

    await act(async () => {
      coinbase.held[0]?.accept();
    });

    expect(coinbase.sent).toHaveLength(1);
    await waitFor(() => expect(screen.getByText(WALLET_WORDS.payoutSent)).toBeTruthy());
  });

  it("keeps saying a payout was sent when an earlier press is closed after it", async () => {
    coinbase.holding = 1;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "test", wallet: W })} />));
    await act(async () => {
      fireEvent.click(button());
    });
    await press();
    coinbase.declines = "wallet_sendCalls";

    await act(async () => {
      coinbase.held[0]?.accept();
    });

    expect(coinbase.sent).toHaveLength(1);
    expect(screen.getByText(WALLET_WORDS.payoutSent)).toBeTruthy();
  });

  it("never says nothing was sent after a payout went out, when a later press into the same window is closed", async () => {
    coinbase.holding = 2;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "test", wallet: W })} />));
    for (const _ of [1, 2]) {
      await act(async () => {
        fireEvent.click(button());
      });
    }

    await act(async () => {
      coinbase.held[0]?.accept();
    });
    await waitFor(() => expect(coinbase.sent).toHaveLength(1));
    await act(async () => {
      coinbase.held[1]?.decline();
    });

    expect(screen.queryByText(WALLET_WORDS.payoutClosed)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutEarlierStands)).toBeTruthy();
  });

  it("is not offered where there is no transaction to send", () => {
    render(
      routed(() => (
        <SettingsScreen
          view={viewOf({ mode: "test", wallet: W, splits: splitsFor("test", W, { tooMany: 21 }) })}
        />
      )),
    );

    expect(screen.queryByRole("button", { name: WALLET_WORDS.payOut })).toBeNull();
  });
});
