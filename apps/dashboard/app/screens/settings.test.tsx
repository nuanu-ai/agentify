// @vitest-environment jsdom

/**
 * What the settings screen says about the payout wallet and the operator's
 * approval, drawn from views built out of documents the contract's schemas
 * accept, so nothing is stubbed. Each page is drawn as the server sends it, and
 * the press on the wallet form alive in a document. The presses themselves are
 * driven over HTTP in `server.test.ts`.
 */

import type { SurfaceMode } from "@agentify/core";
import { checksummedAddressOf, PayoutWalletSchema } from "@nuanu-ai/agentify-contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { type SettingsPress, settingsView } from "../../src/settings-view.js";
import { readable } from "../../src/testing/html.js";
import { PayoutWalletPanel, SettingsScreen } from "./settings.js";

/** Of the right shape, and obviously not a real address. */
const SHAPED = "0x0123456789abcdef0123456789abcdef01234567";
const WAITING = checksummedAddressOf("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");

interface Looking {
  readonly mode?: SurfaceMode;
  readonly wallet?: string | null;
  readonly pending?: string;
  readonly liveApproval?: boolean;
  readonly press?: SettingsPress;
}

const viewOf = ({ mode = "sandbox", wallet = null, pending, liveApproval, press }: Looking) =>
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

const asCopied = (html: string): string => html.replaceAll(/<[^>]*>/g, "");

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

  it("names Base Sepolia and test USDC on the test stack", () => {
    const text = readable(walletPanel({ wallet: null, mode: "test" }));

    expect(text).toContain("Base Sepolia");
    expect(text).toContain("test USDC");
    expect(text).toMatch(/settle/i);
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
