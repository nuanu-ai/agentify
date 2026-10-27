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
import { type SurfaceMode, UNKNOWN } from "@agentify/core";
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
import {
  PAYOUT_NOTES,
  type PayoutView,
  type SettingsPress,
  settingsView,
} from "../../src/settings-view.js";
import { readable } from "../../src/testing/html.js";
import { TEST_AUTH_SECRET } from "../../src/testing/secrets.js";
import { WALLET_WORDS } from "../wallet/buttons.js";
import type { Wallet } from "../wallet/requests.js";
import { WALLET_ANSWERS_WITHIN_MS } from "../wallet/waiting.js";
import { PayoutWalletPanel, SettingsScreen } from "./settings.js";

/**
 * Coinbase Wallet as the page meets it, standing in for Coinbase's window: a
 * window it opens names `account`, which the provider then remembers in the
 * page until it is disconnected; it is switched to a chain, keeps the batches
 * it sent and refuses one for a chain it is not on. `opened` is false where
 * the module that brings Coinbase Wallet cannot be opened at all, and the next
 * `holding` windows wait in `held` to be answered by hand, as a window left
 * open does, or a vanished one never is.
 *
 * As the provider does, it keeps one session with its window for the whole
 * page: a disconnection begins a new one, an answer to a request made in an
 * earlier session can no longer be read (4100), and such a failure itself
 * disconnects the provider. Each test gets a provider of its own, as each
 * page load does.
 */
const coinbase = vi.hoisted(() => ({
  opened: true,
  account: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
  remembered: null as readonly string[] | null,
  session: 0,
  holding: 0,
  held: [] as Readonly<{
    accept: (account?: string) => void;
    decline: () => void;
    fail: () => void;
  }>[],
  declines: undefined as string | undefined,
  breaks: undefined as string | undefined,
  /** A request whose answer the provider can no longer read. */
  loses: undefined as string | undefined,
  /** The next payout waits in `answerLater` to be answered by hand, as a window left open or a vanished one. */
  holdsPayout: false,
  answerLater: [] as Readonly<{ acknowledge: () => void; decline: () => void }>[],
  /** Whether the keys of a session with Coinbase's window are kept in the page's storage. */
  keys: false,
  /** A request the provider answers by throwing `thrown`, which need not be an error EIP-1193 describes. */
  throws: undefined as Readonly<{ at: string; thrown: unknown }> | undefined,
  chain: "0x2105",
  sent: [] as Readonly<{ chainId: string; calls: readonly unknown[] }>[],
  provider: undefined as Wallet | undefined,
}));

vi.mock("../wallet/coinbase.js", async () => {
  const requests = await import("../wallet/requests.js");
  const provider = (): Wallet => ({
    async disconnect() {
      coinbase.remembered = null;
      coinbase.session += 1;
      coinbase.keys = false;
    },
    async request({ method, params }) {
      if (method === coinbase.declines) throw { code: 4001, message: "User rejected the request." };
      if (method === coinbase.throws?.at) throw coinbase.throws.thrown;
      if (method === coinbase.breaks) throw { code: -32603, message: "insufficient funds for gas" };
      if (method === coinbase.loses) {
        throw {
          code: 4100,
          message: "Invalid session: no shared secret found when decrypting response",
        };
      }
      if (method === "eth_requestAccounts") {
        if (coinbase.remembered !== null) return coinbase.remembered;
        coinbase.keys = true;
        if (coinbase.holding > 0) {
          coinbase.holding -= 1;
          const asked = coinbase.session;
          return new Promise((resolve, reject) => {
            const unreadable = () => {
              if (coinbase.session === asked) return false;
              coinbase.remembered = null;
              coinbase.session += 1;
              reject({
                code: 4100,
                message: "Invalid session: no shared secret found when decrypting response",
              });
              return true;
            };
            coinbase.held.push({
              accept: (account = coinbase.account) => {
                if (!unreadable()) {
                  coinbase.remembered = [account];
                  resolve([account]);
                }
              },
              decline: () => {
                if (!unreadable()) reject({ code: 4001, message: "User rejected the request." });
              },
              // How the SDK can also fail an answer from a session it no
              // longer has: an error of the browser's cryptography, no code.
              fail: () =>
                reject({ message: "The operation failed for an operation-specific reason" }),
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
        if (coinbase.holdsPayout) {
          coinbase.holdsPayout = false;
          return new Promise((resolve, reject) => {
            coinbase.answerLater.push({
              acknowledge: () => {
                coinbase.sent.push(batch);
                resolve({ id: "0x00b47c4" });
              },
              decline: () => reject({ code: 4001, message: "User rejected the request." }),
            });
          });
        }
        coinbase.sent.push(batch);
        return { id: "0x00b47c4" };
      }
      throw { code: 4200, message: `Unsupported method ${method}` };
    },
  });
  return {
    ...requests,
    coinbaseWallet: () => {
      if (!coinbase.opened) throw new Error("Failed to fetch dynamically imported module");
      coinbase.provider ??= provider();
      return coinbase.provider;
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

/** What the chain says a payout would bring unless a test says otherwise. */
const BRINGS = 12_340_000n;

/** `BRINGS` as the live channel's page writes it. */
const SHOWN = "12.34 USDC";

/**
 * The gateway's answer for a merchant paid at `wallet`, built by its own rule
 * and builder, with what the chain says the payout would bring.
 */
const splitsFor = (
  mode: SurfaceMode,
  wallet: string | null,
  {
    pending,
    toPayOut,
    tooMany,
    brings = BRINGS,
  }: {
    readonly pending?: string;
    readonly toPayOut?: readonly RecordedPayoutSplit[];
    readonly tooMany?: number;
    readonly brings?: bigint | typeof UNKNOWN;
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
          : { transaction: merchantPayout(network, paidOut, PAYOUT_SPLIT_NETWORKS), brings },
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
  /** Null for a merchant who has chosen none. */
  readonly sellerName?: string | null;
  readonly wallet?: string | null;
  readonly pending?: string;
  readonly liveApproval?: boolean;
  readonly press?: SettingsPress;
  /** The gateway's answer about the splits, where it is not the one the wallets give. */
  readonly splits?: PayoutSplits;
}

const viewOf = ({
  mode = "sandbox",
  sellerName = "Freeland",
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
      sellerName,
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
      analyticsOptedOut: false,
      ...(liveApproval === undefined ? {} : { liveApproval }),
    },
    press,
  );

type PayoutKind = PayoutView["kind"];

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

/** An address with its middle left out, the one form a wrong address and the right one share. */
const ELIDED = /0x[0-9a-fA-F]{2,}\s*…/;

/** The text a person reads, with each address whole as it copies off the page. */
const shownText = (html: string): string => readable(html.replaceAll(/<\/?span[^>]*>/g, ""));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.assign(coinbase, {
    holdsPayout: false,
    answerLater: [],
    keys: false,
    opened: true,
    remembered: null,
    session: 0,
    holding: 0,
    held: [],
    loses: undefined,
    throws: undefined,
    provider: undefined,
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
    expect(asCopied(html)).not.toMatch(ELIDED);
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

    expect(text).toMatch(/nothing is settled/i);
    expect(text).toMatch(/optional/i);
  });

  it("leaves the refusal without an address to the banner, where the door asks for one", () => {
    // The banner over every page says no payout wallet is set and that every
    // card is refused until one is; the panel under it does not say it again.
    for (const mode of ["sandbox", "test", "live"] as const) {
      expect(readable(walletPanel({ wallet: null, mode })), mode).not.toMatch(/refused/i);
    }
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
    expect(text).toMatch(/your share of each sale/i);
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

  it("names the wallet paid before when a cancel came too late, so it can be set again", () => {
    const html = walletPanel({
      mode: "live",
      wallet: WAITING,
      press: {
        kind: "wallet-notice",
        notice: {
          kind: "landed",
          wallet: WAITING,
          at: "2026-08-28T12:00:00Z",
          before: SHAPED,
          askedBack: false,
        },
      },
    });

    expect(asCopied(html.slice(0, html.indexOf("<h2")))).toContain(SHAPED);
    expect(html).toContain('action="/products?selling=pause"');
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
    const box = screen.getByLabelText(/wallet address/i);
    fireEvent.change(box, { target: { value: WAITING } });
    const form = box.closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    return form;
  };

  it("says on live that every account is told before it is recorded, so the wait does not look frozen", () => {
    const form = pressed({ mode: "live", wallet: SHAPED });

    const said = within(form).getByRole("status").textContent ?? "";
    expect(said).toMatch(/emailing everyone on your account/i);
    expect(said).toMatch(/30 seconds/);
    expect(screen.getByRole("button", { name: "Change wallet" }).hasAttribute("disabled")).toBe(
      true,
    );
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
      /emailing everyone/i,
    );
  });
});

describe("the name the products are sold under, over the settings", () => {
  const settings = (looking: Looking): string =>
    readable(renderToString(routed(() => <SettingsScreen view={viewOf(looking)} />)));

  it("holds the name buyers read in its box, and leaves a missing one to the banner", () => {
    // The banner over every page says no seller name is set and what that
    // holds back; said again here it would be the same sentence twice.
    const page = renderToString(
      routed(() => <SettingsScreen view={viewOf({ sellerName: "Freeland" })} />),
    );
    expect(page).toMatch(/<input(?=[^>]*name="seller_name")(?=[^>]*value="Freeland")[^>]*>/);
    expect(settings({ sellerName: null })).not.toMatch(/not set a seller name|cannot be published/);
  });

  it("says a name cannot be removed only to a merchant who has one, and asks one without for a name", () => {
    const emptied = { kind: "name", problem: "it was refused", typed: "" } as const;

    expect(settings({ sellerName: "Freeland", press: emptied })).toContain("it was refused");
    expect(settings({ sellerName: null, press: emptied })).not.toContain("it was refused");
    expect(settings({ sellerName: null, press: emptied })).toMatch(/enter a seller name/i);
  });

  it("names the characters of a refused name that cannot be used", () => {
    const text = settings({
      press: { kind: "name", problem: "Your name was not saved.", typed: "Freeland — eSIM & VPN" },
    });

    expect(text).toContain("“—” can't be used.");
  });
});

describe("whether a live merchant is approved", () => {
  const settings = (looking: Looking): string =>
    readable(renderToString(routed(() => <SettingsScreen view={viewOf(looking)} />)));

  it("says on Settings that Agentify has approved the merchant, and leaves a missing approval to the banner", () => {
    // The banner over every page says the approval is still to come; said
    // again here it would be the same sentence twice on one screen.
    const approved = settings({ mode: "live", wallet: SHAPED, liveApproval: true });
    const waiting = settings({ mode: "live", wallet: SHAPED, liveApproval: false });

    expect(approved).toMatch(/Agentify has approved your business for live sales/);
    expect(waiting).not.toMatch(/approved your business/i);
  });

  it("says nothing about the approval off the live channel, where nobody needs it", () => {
    for (const mode of ["sandbox", "test"] as const) {
      expect(settings({ mode, wallet: SHAPED, liveApproval: false }), mode).not.toMatch(
        /approved your business/i,
      );
    }
  });
});

/** A share of the payout split's total, formatted from the network's own terms. */
const percent = (part: number, whole: number): string => `${(part / whole) * 100}%`;

/** The terms of the Base Sepolia experiment's splits: 97% to the merchant and 3% to Agentify. */
const AT_THREE_PERCENT = { commissionAllocation: 30_000, totalAllocation: 1_000_000 } as const;

describe("the commission, before a merchant saves their first wallet", () => {
  // Saving the wallet on a screen that names the commission is the merchant's
  // consent to it, so it is said in the form that saves, by its button. It
  // covers a sale given back, since the merchant refunds the whole price and
  // the commission stays.
  /** The wallet's form, as the page sends it. */
  const walletFormIn = (html: string): string =>
    /<form[^>]*action="\/settings\/payout-wallet"[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";

  for (const mode of ["test", "live"] as const) {
    it(`names on ${mode} the rate, a refunded sale included, and that saving agrees to it, in the form that saves`, () => {
      const network = networkOf(mode);
      const form = readable(walletFormIn(walletPanel({ mode, wallet: null })));
      const commission = percent(network.commissionAllocation, network.totalAllocation);

      expect(form).toContain(`Agentify keeps ${commission} of each sale, refunded sales included`);
      expect(form).toMatch(/saving a wallet means you agree to this fee/i);
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
          payout: {
            transaction: merchantPayout(network, [split], PAYOUT_SPLIT_NETWORKS),
            brings: BRINGS,
          },
        },
      }),
    );

    expect(text).toContain("Agentify keeps 3% of each sale");
    expect(text).not.toContain("99.9%");
    expect(text).not.toContain("0.1%");
  });

  it("says in the sandbox that nothing is settled or paid out there", () => {
    const text = readable(walletPanel({ mode: "sandbox", wallet: null }));

    expect(text).toMatch(/Agentify keeps \S+% of each sale/);
    expect(text).toMatch(/nothing is settled or paid out here/i);
    expect(readable(walletPanel({ mode: "test", wallet: null }))).not.toMatch(
      /nothing is settled/i,
    );
  });
});

describe("the payout contract buyers pay into", () => {
  const W = SHAPED;

  it("is shown whole beside the saved wallet, with a link to it on the test channel's explorer", () => {
    const split = splitOf("test", W).address;
    const html = walletPanel({ mode: "test", wallet: W });

    expect(asCopied(html)).toContain(split);
    expect(asCopied(html)).not.toMatch(ELIDED);
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
    expect(readable(html)).not.toMatch(/see its balance/i);
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

  it("shows a waiting wallet whole, first in its section, with the press that cancels it", () => {
    const html = walletPanel({ mode: "live", wallet: W, pending: WAITING });
    const first = html.slice(0, html.indexOf("<h2"));

    expect(asCopied(first)).toContain(WAITING);
    expect(first).toContain('action="/settings/payout-wallet/cancel"');
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

    expect(linked.size).toBeGreaterThan(1);
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
    expect(text).toContain(PAYOUT_NOTES.multicall3);
    expect(text).toMatch(/ETH to send 0\b/);
  });

  it("gives the whole data the builder makes for the merchant's recorded split, never cut", () => {
    const html = settingsPage({ mode: "test", wallet: W });
    const built = merchantPayout(
      networkOf("test"),
      [splitOf("test", W)],
      PAYOUT_SPLIT_NETWORKS,
    ).data;

    expect(dataIn(html)).toBe(built);
    expect(dataIn(html)).toHaveLength(3_658);
    expect(asCopied(html)).not.toMatch(ELIDED);
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

    expect(onTest).toMatch(/send this transaction on Base Sepolia only/i);
    expect(onTest).toMatch(/test ETH/);
    expect(onLive).toMatch(/send this transaction on Base only/i);
    expect(onLive).not.toMatch(/Base Sepolia|test ETH/);
    expect(dataIn(settingsPage({ mode: "live", wallet: W }))).toBe(
      merchantPayout(networkOf("live"), [splitOf("live", W)], PAYOUT_SPLIT_NETWORKS).data,
    );
  });

  it("links to how to send it from another wallet, and says that otherwise Agentify pays it out on no fixed date", () => {
    // Whether a wallet shows a field for the data, and where, is the payout
    // page's to say: it is written from what sending one shows.
    const html = settingsPage({ mode: "test", wallet: W });

    expect(html).toContain('href="/docs/payout#with-any-other-wallet"');
    expect(readable(html)).toContain(PAYOUT_NOTES.orAgentify);
  });

  it("is not drawn in the sandbox, where nothing is ever deployed", () => {
    const html = settingsPage({ mode: "sandbox", wallet: W });

    expect(html).not.toContain(MULTICALL3);
    expect(html).not.toContain("<textarea");
    expect(readable(html)).not.toMatch(/getting paid/i);
  });

  it("is not drawn where no split can hold the merchant's money", () => {
    const html = settingsPage({
      mode: "test",
      wallet: W,
      splits: { ...splitsFor("test", W), payout: null },
    });

    expect(html).not.toContain("<textarea");
    expect(readable(html)).not.toMatch(/getting paid/i);
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
      ...html.matchAll(/<tr><td[^>]*>([\s\S]*?)<\/td><td[^>]*>([\s\S]*?)<\/td><\/tr>/g),
    ].map((row) => [asCopied(row[1] ?? ""), asCopied(row[2] ?? "")]);
    const data = dataIn(html).toLowerCase();

    expect(pairs).toStrictEqual([
      [earlier.address, W1],
      [now.address, W],
    ]);
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
    expect(text).toMatch(/no fixed date/);
    expect(html).not.toContain(MULTICALL3);
    expect(html).not.toContain("<textarea");
  });
});

describe("what Getting paid says in each state", () => {
  const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const W1 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
  /**
   * Every state the section can be in, keyed by its kind so a kind added to the
   * view does not compile here until it has a case.
   */
  const STATES: Readonly<Record<PayoutKind, readonly (readonly [string, Looking])[]>> = {
    send: [
      ["one contract", { mode: "test", wallet: W }],
      ["on the live channel", { mode: "live", wallet: W }],
      [
        "an amount the network did not give",
        { mode: "test", wallet: W, splits: splitsFor("test", W, { brings: UNKNOWN }) },
      ],
      [
        "contracts paying two wallets",
        {
          mode: "live",
          wallet: W,
          splits: splitsFor("live", W, { toPayOut: [splitOf("live", W1), splitOf("live", W)] }),
        },
      ],
    ],
    too_many: [
      [
        "more contracts than one transaction carries",
        { mode: "test", wallet: W, splits: splitsFor("test", W, { tooMany: 21 }) },
      ],
    ],
    nothing: [
      [
        "a payout that would bring nothing",
        { mode: "live", wallet: W, splits: splitsFor("live", W, { brings: 0n }) },
      ],
    ],
    unbuilt: [
      [
        "a transaction that could not be built",
        { mode: "test", wallet: W, splits: { ...splitsFor("test", W), payout: "unbuilt" } },
      ],
    ],
  };
  /** A text's sentences, each count in it written `#`, since a note says the count it is given. */
  const sentencesOf = (text: string): string[] =>
    text
      .replaceAll(/\d+/g, "#")
      .split(/(?<=\.)\s+/)
      .map((one) => one.trim())
      .filter((one) => one.endsWith("."));
  const { brings, tooMany, sentOn, ...plain } = PAYOUT_NOTES;
  const NOTED = new Set([
    ...Object.values(plain).flatMap(sentencesOf),
    ...Object.values(sentOn).flatMap(sentencesOf),
    ...[1, 2].flatMap((count) => sentencesOf(tooMany(count))),
    // An amount is written as digits, which `sentencesOf` reads as `#`.
    ...["1.1 USDC", "1.1 test USDC"].flatMap((amount) =>
      [true, false].flatMap((one) => sentencesOf(brings(amount, one))),
    ),
  ]);
  /**
   * Every sentence the section draws, read off each element that holds text of
   * its own. Links and controls are ways on, not claims, and a label that is no
   * sentence, a heading or a column's name, is not read.
   */
  const sentencesIn = (html: string): string[] => {
    const section = document.createElement("div");
    section.innerHTML =
      /<section[^>]*aria-labelledby="getting-paid"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    for (const away of section.querySelectorAll("a, button, textarea")) away.remove();
    return [...section.querySelectorAll("*")].flatMap((element) =>
      [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
      )
        ? sentencesOf(element.textContent ?? "")
        : [],
    );
  };

  it.each(
    Object.entries(STATES).flatMap(([kind, cases]) =>
      cases.map(([state, looking]) => [state, kind, looking] as const),
    ),
  )("says nothing for %s but the notes of Getting paid", (_state, kind, looking) => {
    // A claim about money is then written, and reviewed, in one table; whether
    // a note is true of the system is that review's, not this test's.
    const said = sentencesIn(settingsPage(looking));

    expect(viewOf(looking).payout?.kind).toBe(kind);
    expect(said.length).toBeGreaterThan(0);
    expect(said.filter((sentence) => !NOTED.has(sentence))).toStrictEqual([]);
  });
});

describe("what the payout would bring", () => {
  const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

  const pageWith = (mode: SurfaceMode, brings: bigint | typeof UNKNOWN, more: Looking = {}) =>
    settingsPage({ mode, wallet: W, splits: splitsFor(mode, W, { brings }), ...more });

  /** An amount of USDC as the page writes one, with or without the word test. */
  const AN_AMOUNT = /\b\d+\.\d+ (test )?USDC\b/;

  it("is named, in test USDC on the test channel and in USDC on live", () => {
    expect(readable(pageWith("test", 12_340_000n))).toMatch(/would bring 12\.34 test USDC/);
    const onLive = readable(pageWith("live", 12_340_000n));
    expect(onLive).toMatch(/would bring 12\.34 USDC/);
    expect(onLive).not.toMatch(/test USDC/);
  });

  it("is written whole below a cent, never rounded to nothing", () => {
    expect(readable(pageWith("live", 999n))).toMatch(/would bring 0\.000999 USDC/);
  });

  it("is shown only beside the transaction it was read for, never where no transaction is drawn", () => {
    const shown = pageWith("live", 12_340_000n);
    const tooMany = settingsPage({
      mode: "live",
      wallet: W,
      splits: splitsFor("live", W, { tooMany: 21 }),
    });
    const unbuilt = settingsPage({
      mode: "live",
      wallet: W,
      splits: { ...splitsFor("live", W), payout: "unbuilt" },
    });

    expect(shown).toContain("<textarea");
    expect(readable(shown)).toMatch(AN_AMOUNT);
    for (const html of [tooMany, unbuilt]) {
      expect(html).not.toContain("<textarea");
      expect(readable(html)).not.toMatch(AN_AMOUNT);
    }
  });

  it("leaves no payout to send where it is nothing, and says so", () => {
    const html = pageWith("live", 0n);
    const text = readable(html);

    expect(html).not.toContain("<textarea");
    expect(html).not.toContain(MULTICALL3);
    expect(text).toMatch(/getting paid/i);
    expect(text).toMatch(/would bring nothing/);
    expect(text).not.toMatch(AN_AMOUNT);
  });

  it("is said not to be known, never as nothing, where the chain was not read, and the transaction is still given to send by hand", () => {
    const html = pageWith("test", UNKNOWN);
    const text = readable(html);

    expect(text).toMatch(/could not read from the network what this payout would bring/);
    expect(text).not.toMatch(/would bring nothing/);
    expect(text).not.toMatch(AN_AMOUNT);
    expect(/<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1]).toBe(
      merchantPayout(networkOf("test"), [splitOf("test", W)], PAYOUT_SPLIT_NETWORKS).data,
    );
  });

  it("is between them where the payout pays two wallets, each named beside its contract", () => {
    const W1 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
    const text = readable(
      settingsPage({
        mode: "live",
        wallet: W,
        splits: splitsFor("live", W, { toPayOut: [splitOf("live", W1), splitOf("live", W)] }),
      }),
    );

    expect(text).toMatch(/would bring 12\.34 USDC to the wallets beside your payout contracts/);
  });
});

describe("creating or connecting a Coinbase Wallet from the settings", () => {
  const CHECKSUMMED = checksummedAddressOf(coinbase.account);
  const button = () => screen.getByRole("button", { name: WALLET_WORDS.connect });
  const box = () => screen.getByLabelText(/wallet address/i) as HTMLInputElement;
  const press = async (control: HTMLElement) => {
    await act(async () => {
      fireEvent.click(control);
    });
    await waitFor(() => expect(screen.queryByText(WALLET_WORDS.waitingAddress)).toBeNull());
  };

  it("is offered only once the page's script runs, so a page without script shows no button that does nothing", () => {
    expect(walletPanel({ mode: "live" })).not.toContain(WALLET_WORDS.connect);

    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));

    expect(button()).toBeTruthy();
  });

  it("is offered on the test channel as on live, since connecting a Coinbase Wallet works on Base Sepolia", () => {
    const { wallet } = viewOf({ mode: "test" });
    render(routed(() => <PayoutWalletPanel wallet={wallet} />));

    expect(button()).toBeTruthy();
    expect(wallet.coinbase).toStrictEqual({ chain: 84532 });
  });

  it("is not offered in the sandbox, where no wallet is ever paid", () => {
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "sandbox" }).wallet} />));

    expect(screen.queryByRole("button", { name: WALLET_WORDS.connect })).toBeNull();
  });

  it("puts the wallet's address into the box in a wallet's spelling, and saves nothing until the merchant presses Save", async () => {
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));
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

  it("leaves the button and the box usable while it waits, so a window that closed without a word strands nobody", async () => {
    coinbase.holding = 1;
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));

    await act(async () => {
      fireEvent.click(button());
    });

    expect(screen.getByText(WALLET_WORDS.waitingAddress)).toBeTruthy();
    expect((button() as HTMLButtonElement).disabled).toBe(false);
    expect(box().disabled || box().readOnly).toBe(false);
  });

  it("leaves the box as the merchant left it when Coinbase's window closes, however it closed, and points to entering an address by hand", async () => {
    coinbase.declines = "eth_requestAccounts";
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));
    fireEvent.change(box(), { target: { value: "0x1234" } });

    await press(button());

    expect(box().value).toBe("0x1234");
    expect(box().disabled || box().readOnly).toBe(false);
    expect(screen.getByText(WALLET_WORDS.connectClosed)).toBeTruthy();
  });

  it("keeps the box for an address typed by hand when Coinbase Wallet cannot be opened", async () => {
    coinbase.opened = false;
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));
    fireEvent.change(box(), { target: { value: "0x1234" } });

    await press(button());

    expect(box().value).toBe("0x1234");
    expect(screen.getByText(WALLET_WORDS.connectNotOpened)).toBeTruthy();
  });

  it("says in words of its own, never the wallet's or the browser's, that no address came", async () => {
    for (const thrown of [
      { code: -32603, message: "insufficient funds for gas" },
      new TypeError("Cannot use 'in' operator to search for 'failure' in undefined"),
    ]) {
      coinbase.throws = { at: "eth_requestAccounts", thrown };
      render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));

      await press(button());

      expect(screen.queryByText(new RegExp(thrown.message))).toBeNull();
      expect(screen.getByText(WALLET_WORDS.connectFailed)).toBeTruthy();
      cleanup();
      coinbase.provider = undefined;
    }
  });

  it("takes a second press while the first is still unanswered, as when Coinbase's window vanished without a word", async () => {
    coinbase.holding = 1;
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));
    await act(async () => {
      fireEvent.click(button());
    });

    await press(button());

    expect(box().value).toBe(CHECKSUMMED);
    expect(screen.getByText(WALLET_WORDS.addressInTheBox)).toBeTruthy();
  });

  it("keeps what the latest press brought when an earlier press is answered after it", async () => {
    coinbase.holding = 1;
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));
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

  it("says its answer was lost, not that it failed, when a payout press meanwhile ends its session", async () => {
    coinbase.holding = 1;
    const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));
    await act(async () => {
      fireEvent.click(button());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: WALLET_WORDS.payOut }));
    });
    await waitFor(() => expect(screen.getByText(WALLET_WORDS.payoutSent(SHOWN))).toBeTruthy());

    await act(async () => {
      coinbase.held[0]?.accept();
    });

    expect(screen.getByText(WALLET_WORDS.connectLost)).toBeTruthy();
  });

  it("says its answer was lost, not the browser's words, when a payout press overtook it and the answer failed", async () => {
    coinbase.holding = 1;
    const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));
    await act(async () => {
      fireEvent.click(button());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: WALLET_WORDS.payOut }));
    });
    await waitFor(() => expect(screen.getByText(WALLET_WORDS.payoutSent(SHOWN))).toBeTruthy());

    await act(async () => {
      coinbase.held[0]?.fail();
    });

    expect(screen.getByText(WALLET_WORDS.connectLost)).toBeTruthy();
  });

  it("stops waiting once Coinbase Wallet has not answered within the limit, says to press again, and leaves no keys of its session in the page", async () => {
    vi.useFakeTimers();
    coinbase.holding = 1;
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));
    fireEvent.change(box(), { target: { value: "0x1234" } });
    await act(async () => {
      fireEvent.click(button());
    });
    await act(() => vi.advanceTimersByTimeAsync(WALLET_ANSWERS_WITHIN_MS - 1));
    expect(screen.getByText(WALLET_WORDS.waitingAddress)).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(screen.queryByText(WALLET_WORDS.waitingAddress)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.connectUnanswered)).toBeTruthy();
    expect(coinbase.keys).toBe(false);
    expect(box().value).toBe("0x1234");
  });

  it("puts no address into the box that arrives after it stopped waiting", async () => {
    vi.useFakeTimers();
    coinbase.holding = 1;
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));
    fireEvent.change(box(), { target: { value: "0x1234" } });
    await act(async () => {
      fireEvent.click(button());
    });
    await act(() => vi.advanceTimersByTimeAsync(WALLET_ANSWERS_WITHIN_MS));

    await act(async () => {
      coinbase.held[0]?.accept();
    });

    expect(box().value).toBe("0x1234");
    expect(screen.getByText(WALLET_WORDS.connectUnanswered)).toBeTruthy();
  });

  it("takes the refusal of an earlier address off the box it fills, so it is not read out against the new one", async () => {
    const refused = "That is not an address.";
    render(
      routed(() => (
        <PayoutWalletPanel
          wallet={
            viewOf({
              mode: "live",
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
    // What is shown under the box in groups is the address now in it.
    expect(asCopied(document.getElementById("payout_wallet-entered")?.innerHTML ?? "")).toContain(
      CHECKSUMMED,
    );
  });

  it("links to where the merchant manages the wallet and to how Coinbase recovers it", () => {
    render(routed(() => <PayoutWalletPanel wallet={viewOf({ mode: "live" }).wallet} />));

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
    await waitFor(() => expect(screen.queryByText(WALLET_WORDS.waitingPayout)).toBeNull());
  };

  it("is offered only once the page's script runs, beside the transaction it sends", () => {
    expect(settingsPage({ mode: "live", wallet: W })).not.toContain(WALLET_WORDS.payOut);

    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

    expect(button()).toBeTruthy();
  });

  it("sends the transaction the screen shows, whole and carrying no money, on Base", async () => {
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

    await press();

    expect(coinbase.sent).toEqual([
      expect.objectContaining({
        chainId: "0x2105",
        calls: [
          {
            to: "0xcA11bde05977b3631167028862bE2a173976CA11",
            value: "0x0",
            data: merchantPayout(networkOf("live"), [splitOf("live", W)], PAYOUT_SPLIT_NETWORKS)
              .data,
          },
        ],
      }),
    ]);
  });

  it("is not offered on the test channel, which says why in one line and keeps the transaction for another wallet", () => {
    const view = viewOf({ mode: "test", wallet: W });
    render(routed(() => <SettingsScreen view={view} />));

    expect(screen.queryByRole("button", { name: WALLET_WORDS.payOut })).toBeNull();
    const payout = view.payout;
    const absent =
      payout?.kind === "send" && payout.coinbase !== null && "absent" in payout.coinbase
        ? payout.coinbase.absent
        : "";
    expect(absent).toMatch(/Base Sepolia/);
    expect(screen.getByText(absent)).toBeTruthy();
    expect(screen.getByLabelText("Data")).toBeTruthy();
  });

  it("says what the wallet was asked to send, with the amount the page showed, and not that the money has arrived", async () => {
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

    await press();

    const said = WALLET_WORDS.payoutSent(SHOWN);
    expect(said).toContain(SHOWN);
    expect(screen.getByText(said)).toBeTruthy();
  });

  it("says what the wallet was asked to send without an amount where the page did not know it", async () => {
    render(
      routed(() => (
        <SettingsScreen
          view={viewOf({
            mode: "live",
            wallet: W,
            splits: splitsFor("live", W, { brings: UNKNOWN }),
          })}
        />
      )),
    );

    await press();

    expect(screen.getByText(WALLET_WORDS.payoutSent(null))).toBeTruthy();
  });

  it("points to the transaction below when Coinbase's window closes before the payout was asked for, however it closed", async () => {
    // Coinbase's window closes the same way when the merchant closes it and
    // when it stops on an error of its own, so the words fit either.
    coinbase.declines = "eth_requestAccounts";
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

    await press();

    expect(screen.getByText(WALLET_WORDS.payoutClosed)).toBeTruthy();
    expect((screen.getByLabelText("Data") as HTMLTextAreaElement).value).toBe(
      merchantPayout(networkOf("live"), [splitOf("live", W)], PAYOUT_SPLIT_NETWORKS).data,
    );
  });

  it("leaves the button usable while it waits, so a window that closed without a word strands nobody", async () => {
    coinbase.holding = 1;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

    await act(async () => {
      fireEvent.click(button());
    });

    expect(screen.getByText(WALLET_WORDS.waitingPayout)).toBeTruthy();
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it("is offered where the page does not know what the payout would bring, since it pays out only what is there", () => {
    render(
      routed(() => (
        <SettingsScreen
          view={viewOf({
            mode: "live",
            wallet: W,
            splits: splitsFor("live", W, { brings: UNKNOWN }),
          })}
        />
      )),
    );

    expect(button()).toBeTruthy();
  });

  it("is not offered where the payout would bring nothing", () => {
    render(
      routed(() => (
        <SettingsScreen
          view={viewOf({ mode: "live", wallet: W, splits: splitsFor("live", W, { brings: 0n }) })}
        />
      )),
    );

    expect(screen.queryByRole("button", { name: WALLET_WORDS.payOut })).toBeNull();
  });

  it("sends nothing and says so when the merchant closes Coinbase's window before the payout is asked for", async () => {
    coinbase.declines = "eth_requestAccounts";
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

    await press();

    expect(coinbase.sent).toEqual([]);
    expect(screen.getByText(WALLET_WORDS.payoutClosed)).toBeTruthy();
  });

  it("never says nothing was sent when the window closes after the payout was asked for, and says to check before sending again", async () => {
    coinbase.declines = "wallet_sendCalls";
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

    await press();

    expect(screen.queryByText(/did not send|Nothing was sent|sent nothing/)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutUnconfirmed)).toBeTruthy();
  });

  it("says in words of its own, never the wallet's or the browser's, that nothing was sent when the wallet stops before the payout is asked for", async () => {
    for (const thrown of [
      { code: -32603, message: "insufficient funds for gas" },
      new TypeError("Cannot use 'in' operator to search for 'failure' in undefined"),
    ]) {
      coinbase.throws = { at: "wallet_switchEthereumChain", thrown };
      render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

      await press();

      expect(coinbase.sent).toEqual([]);
      expect(screen.queryByText(new RegExp(thrown.message))).toBeNull();
      expect(screen.getByText(WALLET_WORDS.payoutNotSent)).toBeTruthy();
      cleanup();
      coinbase.provider = undefined;
    }
  });

  it("says nothing was sent when Coinbase Wallet cannot be opened", async () => {
    coinbase.opened = false;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

    await press();

    expect(screen.getByText(WALLET_WORDS.payoutNotSent)).toBeTruthy();
  });

  it("takes a second press while the first is still unanswered, and says what it sent", async () => {
    coinbase.holding = 1;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));
    await act(async () => {
      fireEvent.click(button());
    });

    await press();

    expect(coinbase.sent).toHaveLength(1);
    expect(screen.getByText(WALLET_WORDS.payoutSent(SHOWN))).toBeTruthy();
  });

  it("says it does not know, rather than that nothing was sent, once an earlier press's answer can no longer be read", async () => {
    coinbase.holding = 1;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));
    await act(async () => {
      fireEvent.click(button());
    });
    coinbase.declines = "eth_requestAccounts";
    await press();
    coinbase.declines = undefined;

    await act(async () => {
      coinbase.held[0]?.accept();
    });

    expect(screen.queryByText(WALLET_WORDS.payoutClosed)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutUnknown)).toBeTruthy();
  });

  it("never says nothing was sent when two presses wait in one window and neither answer can be read", async () => {
    coinbase.holding = 2;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));
    for (const _ of [1, 2]) {
      await act(async () => {
        fireEvent.click(button());
      });
    }

    await act(async () => {
      coinbase.held[0]?.accept();
    });
    await act(async () => {
      coinbase.held[1]?.decline();
    });

    expect(screen.queryByText(WALLET_WORDS.payoutClosed)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutUnknown)).toBeTruthy();
  });

  it("does not say a waiting payout failed when filling the wallet box meanwhile ends its session", async () => {
    coinbase.holding = 1;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));
    await act(async () => {
      fireEvent.click(button());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: WALLET_WORDS.connect }));
    });
    await waitFor(() => expect(screen.getByText(WALLET_WORDS.addressInTheBox)).toBeTruthy());

    await act(async () => {
      coinbase.held[0]?.accept();
    });

    expect(screen.queryByText(/did not send the payout/)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutUnknown)).toBeTruthy();
  });

  it("says nothing more was sent, rather than that nothing was, when a later press is closed after a payout went out", async () => {
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));
    await press();
    coinbase.declines = "eth_requestAccounts";

    await press();

    expect(coinbase.sent).toHaveLength(1);
    expect(screen.queryByText(WALLET_WORDS.payoutClosed)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutEarlierStands)).toBeTruthy();
  });

  it("says it does not know whether the payout went out when the wallet's answer to it can no longer be read", async () => {
    coinbase.loses = "wallet_sendCalls";
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

    await press();

    expect(screen.getByText(WALLET_WORDS.payoutUnknown)).toBeTruthy();
  });

  it("never says the payout was not sent when the wallet's answer to it is a failure the page cannot read", async () => {
    for (const thrown of [
      { message: "The operation failed for an operation-specific reason" },
      new TypeError("Cannot use 'in' operator to search for 'failure' in undefined"),
    ]) {
      coinbase.throws = { at: "wallet_sendCalls", thrown };
      render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));

      await press();

      expect(screen.queryByText(/did not send|Nothing was sent|sent nothing/)).toBeNull();
      expect(screen.getByText(WALLET_WORDS.payoutUnknown)).toBeTruthy();
      cleanup();
      coinbase.provider = undefined;
    }
  });

  it("keeps saying it does not know when a later press is closed", async () => {
    coinbase.loses = "wallet_sendCalls";
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));
    await press();
    coinbase.loses = undefined;
    coinbase.declines = "eth_requestAccounts";

    await press();

    expect(screen.queryByText(WALLET_WORDS.payoutClosed)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutUnknown)).toBeTruthy();
  });

  it("does not say a waiting payout failed when filling the wallet box meanwhile overtook it and its answer failed", async () => {
    coinbase.holding = 1;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));
    await act(async () => {
      fireEvent.click(button());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: WALLET_WORDS.connect }));
    });
    await waitFor(() => expect(screen.getByText(WALLET_WORDS.addressInTheBox)).toBeTruthy());

    await act(async () => {
      coinbase.held[0]?.fail();
    });

    expect(screen.queryByText(/did not send the payout/)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutUnknown)).toBeTruthy();
  });

  it("says it does not know, not that nothing was sent, when the screen was drawn again while a payout waited", async () => {
    coinbase.holding = 1;
    const screenOf = () =>
      routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />);
    const { rerender } = render(screenOf());
    await act(async () => {
      fireEvent.click(button());
    });
    rerender(<div />);
    rerender(screenOf());
    coinbase.declines = "eth_requestAccounts";

    await press();
    await act(async () => {
      coinbase.held[0]?.accept();
    });

    expect(screen.queryByText(WALLET_WORDS.payoutClosed)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutUnknown)).toBeTruthy();
  });

  it("says it does not know, not that nothing was sent, while an earlier payout press still waits", async () => {
    coinbase.holding = 1;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));
    await act(async () => {
      fireEvent.click(button());
    });
    coinbase.declines = "eth_requestAccounts";

    await press();

    expect(screen.queryByText(WALLET_WORDS.payoutClosed)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutUnknown)).toBeTruthy();
  });

  /** A payout pressed whose window then gives no answer for as long as the page waits. */
  const unansweredFor = async (ms: number) => {
    vi.useFakeTimers();
    coinbase.holdsPayout = true;
    render(routed(() => <SettingsScreen view={viewOf({ mode: "live", wallet: W })} />));
    await act(async () => {
      fireEvent.click(button());
    });
    await act(() => vi.advanceTimersByTimeAsync(ms));
  };

  it("keeps waiting for a payout until the limit, long enough to approve it with a passkey", async () => {
    await unansweredFor(WALLET_ANSWERS_WITHIN_MS - 1);

    expect(screen.getByText(WALLET_WORDS.waitingPayout)).toBeTruthy();
    expect(coinbase.keys).toBe(true);
  });

  it("says it does not know whether the payout went out once the limit passes, and leaves no keys of the wallet's session in the page", async () => {
    await unansweredFor(WALLET_ANSWERS_WITHIN_MS);

    expect(screen.queryByText(WALLET_WORDS.waitingPayout)).toBeNull();
    expect(screen.queryByText(/did not send|Nothing was sent|sent nothing/)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutUnanswered)).toBeTruthy();
    expect(coinbase.keys).toBe(false);
  });

  it("says the payout was sent when the wallet acknowledges it after the limit", async () => {
    await unansweredFor(WALLET_ANSWERS_WITHIN_MS);

    await act(async () => {
      coinbase.answerLater[0]?.acknowledge();
    });

    expect(screen.getByText(WALLET_WORDS.payoutSent(SHOWN))).toBeTruthy();
  });

  it("keeps saying it does not know when the wallet refuses the payout after the limit", async () => {
    await unansweredFor(WALLET_ANSWERS_WITHIN_MS);

    await act(async () => {
      coinbase.answerLater[0]?.decline();
    });

    expect(screen.queryByText(/did not send|Nothing was sent|sent nothing/)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutUnanswered)).toBeTruthy();
  });

  it("does not say nothing was sent on a later press that is closed, once a payout went unanswered", async () => {
    await unansweredFor(WALLET_ANSWERS_WITHIN_MS);
    coinbase.declines = "eth_requestAccounts";

    await act(async () => {
      fireEvent.click(button());
    });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.queryByText(WALLET_WORDS.payoutClosed)).toBeNull();
    expect(screen.getByText(WALLET_WORDS.payoutUnknown)).toBeTruthy();
  });

  it("is not offered where there is no transaction to send", () => {
    render(
      routed(() => (
        <SettingsScreen
          view={viewOf({ mode: "live", wallet: W, splits: splitsFor("test", W, { tooMany: 21 }) })}
        />
      )),
    );

    expect(screen.queryByRole("button", { name: WALLET_WORDS.payOut })).toBeNull();
  });
});
