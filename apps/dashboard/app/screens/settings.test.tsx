// @vitest-environment jsdom

/**
 * What the settings screen says about the payout wallet and the operator's
 * approval, drawn from views built out of documents the contract's schemas
 * accept, so nothing is stubbed. Each page is drawn as the server sends it, and
 * the press on the wallet form alive in a document. The presses themselves are
 * driven over HTTP in `server.test.ts`.
 */

import type { SurfaceMode } from "@agentify/core";
import {
  merchantPayout,
  payoutSplitFor,
  payoutSplitNetworkOf,
  type RecordedPayoutSplit,
} from "@agentify/gateway";
import { SPLIT_NETWORKS_WITH_A_FIXTURE_BASE } from "@agentify/gateway/testing";
import { checksummedAddressOf, PayoutWalletSchema } from "@nuanu-ai/agentify-contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { PayoutSplits } from "../../src/gateway.js";
import { type SettingsPress, settingsView } from "../../src/settings-view.js";
import { readable } from "../../src/testing/html.js";
import { TEST_AUTH_SECRET } from "../../src/testing/secrets.js";
import { PayoutWalletPanel, SettingsScreen } from "./settings.js";

/** Of the right shape, and obviously not a real address. */
const SHAPED = "0x0123456789abcdef0123456789abcdef01234567";
const WAITING = checksummedAddressOf("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");

/** Each channel as its deployment configures it; Base's commission wallet is a test fixture's. */
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
  payoutSplitNetworkOf(SPLIT_NETWORKS_WITH_A_FIXTURE_BASE, CHANNELS[mode].PAYMENT_NETWORK ?? "");

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
          : merchantPayout(network, paidOut),
  };
};

/** Where this deployment's chain shows an address, as the dashboard's configuration names it. */
const addressPageOn = (mode: SurfaceMode): string | null =>
  loadConfig({
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: TEST_AUTH_SECRET,
    ...CHANNELS[mode],
  }).addressPage;

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
      addressPage: addressPageOn(mode),
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

afterEach(cleanup);

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
  const pressed = (looking: Looking) => {
    render(routed(() => <PayoutWalletPanel wallet={viewOf(looking).wallet} />));
    document.addEventListener("submit", (event) => event.preventDefault(), { once: true });
    const box = screen.getByLabelText(/payout wallet address/i);
    fireEvent.change(box, { target: { value: WAITING } });
    fireEvent.submit(box.closest("form") as HTMLFormElement);
  };

  it("says on live that every account is told before it is recorded, so the wait does not look frozen", () => {
    pressed({ mode: "live", wallet: SHAPED });

    const said = screen.getByRole("status").textContent ?? "";
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
      pressed(looking);

      expect(screen.queryByRole("status"), JSON.stringify(looking)).toBeNull();
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

describe("the commission, before a merchant saves their first wallet", () => {
  // Saving the wallet on a screen that names the commission is the merchant's
  // consent to it, so it is said above the box, before anything is saved.
  for (const mode of ["test", "live"] as const) {
    it(`names on ${mode} the rate, how it is taken, and that saving agrees to it, above the form`, () => {
      const network = networkOf(mode);
      const html = walletPanel({ mode, wallet: null });
      const beforeTheForm = readable(html.slice(0, html.indexOf("<form")));

      expect(beforeTheForm).toContain(
        `Agentify keeps ${percent(network.commissionAllocation, network.totalAllocation)} of every sale`,
      );
      expect(beforeTheForm).toContain(
        `sends ${percent(network.totalAllocation - network.commissionAllocation, network.totalAllocation)} to the wallet`,
      );
      expect(beforeTheForm).toMatch(/buyers pay into a payout contract/i);
      expect(beforeTheForm).toMatch(/nobody, Agentify included, can send the money anywhere else/);
      expect(beforeTheForm).toMatch(/saving a wallet here means you agree to this/i);
      expect(html.indexOf('name="payout_wallet"')).toBeGreaterThan(html.indexOf("<form"));
    });
  }

  it("says in the sandbox that the contract is never deployed and no money moves", () => {
    const text = readable(walletPanel({ mode: "sandbox", wallet: null }));

    expect(text).toMatch(/Agentify keeps \S+% of every sale/);
    expect(text).toMatch(/in the sandbox the contract is never deployed and no money moves/i);
    expect(readable(walletPanel({ mode: "test", wallet: null }))).not.toMatch(/never deployed/);
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
  });

  it("says the rate the recorded split pays, beside it", () => {
    const network = networkOf("test");
    const text = shownText(walletPanel({ mode: "test", wallet: W }));
    const after = text.slice(text.indexOf(splitOf("test", W).address));

    expect(after).toContain(
      `It sends ${percent(network.totalAllocation - network.commissionAllocation, network.totalAllocation)} to the wallet above and ${percent(network.commissionAllocation, network.totalAllocation)} to Agentify`,
    );
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

describe("the payout instruction", () => {
  const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

  /** What the box holding the data holds. */
  const dataIn = (html: string): string =>
    /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? "";

  it("gives Multicall3 as To, with words saying it is a public contract and not ours, and zero as Amount", () => {
    const text = shownText(settingsPage({ mode: "test", wallet: W }));

    expect(text).toContain(`To ${MULTICALL3}`);
    expect(text).toMatch(
      /Multicall3, a public contract that runs several calls in one transaction; it is not ours/,
    );
    expect(text).toMatch(/Amount 0\b/);
  });

  it("gives the whole data the builder makes for the merchant's recorded split, never cut", () => {
    const html = settingsPage({ mode: "test", wallet: W });
    const built = merchantPayout(networkOf("test"), [splitOf("test", W)]).data;

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

    expect(held).toBe(merchantPayout(networkOf("test"), [splitOf("test", W)]).data);
    expect(screen.getByRole("status").textContent).toBe("Copied.");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("names Base Sepolia and test ETH from a faucet on the test channel, and Base on live", () => {
    const onTest = readable(settingsPage({ mode: "test", wallet: W }));
    const onLive = readable(settingsPage({ mode: "live", wallet: W }));

    expect(onTest).toMatch(/send one transaction on Base Sepolia/);
    expect(onTest).toMatch(/test ETH/);
    expect(onTest).toMatch(/faucet/);
    expect(onLive).toMatch(/send one transaction on Base from/);
    expect(onLive).not.toMatch(/Base Sepolia|faucet|test ETH/);
    expect(dataIn(settingsPage({ mode: "live", wallet: W }))).toBe(
      merchantPayout(networkOf("live"), [splitOf("live", W)]).data,
    );
  });

  it("says how to paste data in MetaMask, and that without ETH the merchant is paid when Agentify pays out", () => {
    const text = readable(settingsPage({ mode: "test", wallet: W }));

    expect(text).toMatch(/in MetaMask, turn on Settings → Advanced → Show hex data/);
    expect(text).toMatch(/No ETH on Base Sepolia\? You are paid when Agentify pays out/);
    expect(text).toMatch(/You can get paid out at any time/);
  });

  it("is not drawn in the sandbox, where nothing is ever deployed", () => {
    const html = settingsPage({ mode: "sandbox", wallet: W });

    expect(html).not.toContain(MULTICALL3);
    expect(html).not.toContain("<textarea");
    expect(readable(html)).not.toMatch(/get your payout/i);
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
    // Each wallet is the owner of a withdrawal in the data: `withdraw(owner, token)`.
    for (const [, wallet] of pairs) {
      expect(data).toContain(`f940e385${(wallet ?? "").slice(2).toLowerCase().padStart(64, "0")}`);
    }
  });

  it("says plainly where one transaction cannot pay out every contract, and that Agentify pays them out", () => {
    const html = settingsPage({
      mode: "test",
      wallet: W,
      splits: splitsFor("test", W, { tooMany: 21 }),
    });
    const text = readable(html);

    expect(text).toMatch(/21 payout contracts/);
    expect(text).toMatch(/Agentify pays them out/);
    expect(html).not.toContain(MULTICALL3);
    expect(html).not.toContain("<textarea");
  });
});
