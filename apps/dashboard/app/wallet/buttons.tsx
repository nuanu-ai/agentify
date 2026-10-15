/**
 * Coinbase Wallet's two buttons on the settings screen: one fills the payout
 * wallet box with the merchant's Coinbase Wallet address, the other sends the
 * payout the screen shows. Each is drawn only once the page's script runs, so
 * a page without script shows no button that does nothing, and Coinbase
 * Wallet's code is fetched only for them. Neither saves anything: the box is
 * saved by the merchant's own press, as an address typed by hand is.
 */

import { Button } from "@agentify/ui";
import { useEffect, useRef, useState } from "react";

/**
 * Coinbase Wallet's code, fetched when the pointer reaches a button or it takes
 * the focus, so its window opens as close to the press as a browser asks of a
 * window; a browser that still blocks it gets Coinbase's own prompt to go on.
 */
const coinbase = () => import("./coinbase.js");

export const WALLET_WORDS = {
  connect: "Create or connect a Coinbase Wallet",
  connectLead:
    "Coinbase's window opens over this page, where you create a wallet or connect a Coinbase Wallet you already have, and its address comes into the box below. Nothing is saved until you press the button beside the box.",
  yours:
    "The wallet is yours alone. Agentify cannot reach it, and Coinbase keeps no copy of your passkey or recovery key and cannot recover them, so keeping a way back into it is up to you.",
  manageAt: "https://wallet.coinbase.com",
  recoveryAt: "https://help.coinbase.com/en/wallet/getting-started/smart-wallet-recovery",
  waiting: "Waiting for Coinbase Wallet…",
  addressInTheBox:
    "Your Coinbase Wallet's address is in the box. Check it against the wallet, then save it; nothing has changed yet.",
  connectClosed: "Coinbase Wallet was closed. The box is as you left it.",
  connectFailed: (reason: string) =>
    `Coinbase Wallet gave no address: ${reason}. You can still enter one by hand.`,
  payOut: "Pay out with Coinbase Wallet",
  payoutLead:
    "With a Coinbase Wallet you send it in one step: Coinbase's window shows the transaction and its fee, and nothing is sent until you approve it there.",
  payoutSent:
    "Coinbase Wallet sent the payout. Your share reaches your wallet once the network includes the transaction.",
  payoutClosed: "Coinbase Wallet was closed. Nothing was sent.",
  payoutEarlierStands:
    "Coinbase Wallet sent nothing more. The payout it sent earlier from this page stands.",
  payoutFailed: (reason: string) =>
    `Coinbase Wallet did not send the payout: ${reason}. If your wallet holds nothing yet to pay the fee with, your first payout arrives when Agentify next pays out every contract, on no set date; later ones you can send from here.`,
} as const;

/** What a press on a button answers when Coinbase Wallet's code could not be fetched or started. */
const NOT_OPENED = { kind: "failed", reason: "the page could not open it" } as const;

/** False as the server draws the page, true once its script runs. */
function useScriptRuns(): boolean {
  const [runs, setRuns] = useState(false);
  useEffect(() => setRuns(true), []);
  return runs;
}

/**
 * The status of the latest press. A button is never held disabled while
 * Coinbase Wallet answers, because its window can vanish without answering,
 * as when a phone closes its tab, and a held button would then stay held; a
 * second press is taken, and an earlier one that answers late does nothing.
 */
function useLatestPress(): [
  string,
  () => Readonly<{ latest: () => boolean; say: (said: string) => void }>,
] {
  const [said, setSaid] = useState("");
  const counted = useRef(0);
  const press = () => {
    counted.current += 1;
    const mine = counted.current;
    setSaid(WALLET_WORDS.waiting);
    return { latest: () => mine === counted.current, say: setSaid };
  };
  return [said, press];
}

/** Fills the box whose id is `box` with the wallet's address and leaves saving to the merchant. */
export function CoinbaseAddress({ chainId, box }: Readonly<{ chainId: number; box: string }>) {
  const runs = useScriptRuns();
  const [said, press] = useLatestPress();
  if (!runs) return null;
  const ask = async () => {
    const pressed = press();
    const asked = await coinbase()
      .then(({ askAddress, coinbaseWallet }) => askAddress(coinbaseWallet(chainId)))
      .catch(() => NOT_OPENED);
    if (!pressed.latest()) return;
    if (asked.kind === "address") {
      const field = document.getElementById(box);
      if (field instanceof HTMLInputElement) {
        field.value = asked.address;
        field.focus();
      }
    }
    pressed.say(
      asked.kind === "address"
        ? WALLET_WORDS.addressInTheBox
        : asked.kind === "cancelled"
          ? WALLET_WORDS.connectClosed
          : WALLET_WORDS.connectFailed(asked.reason),
    );
  };
  return (
    <div className="lede">
      <div>
        <p className="copy-row">
          <Button
            type="button"
            variant="secondary"
            onPointerEnter={() => void coinbase().catch(() => undefined)}
            onFocus={() => void coinbase().catch(() => undefined)}
            onClick={() => void ask()}
          >
            {WALLET_WORDS.connect}
          </Button>
        </p>
        <p role="status">{said}</p>
        <p className="quiet">
          {WALLET_WORDS.connectLead} {WALLET_WORDS.yours}{" "}
          <a href={WALLET_WORDS.manageAt} rel="noreferrer">
            Manage your wallet
          </a>{" "}
          ·{" "}
          <a href={WALLET_WORDS.recoveryAt} rel="noreferrer">
            How recovery works
          </a>
        </p>
      </div>
    </div>
  );
}

/** Sends `payout`, the transaction the screen shows, from the merchant's Coinbase Wallet on `chainId`. */
export function CoinbasePayout({
  chainId,
  payout,
}: Readonly<{ chainId: number; payout: Readonly<{ to: string; data: string }> }>) {
  const runs = useScriptRuns();
  const [said, press] = useLatestPress();
  const sentHere = useRef(false);
  if (!runs) return null;
  const send = async () => {
    const pressed = press();
    const sent = await coinbase()
      .then(({ sendPayout, coinbaseWallet }) =>
        sendPayout(coinbaseWallet(chainId), chainId, payout),
      )
      .catch(() => NOT_OPENED);
    // A payout that went out is said whenever it went out, and once one has,
    // no press that sent nothing says nothing was sent: Coinbase's SDK sends a
    // second press into the window the first opened, so the first can send and
    // the second be closed after it.
    if (sent.kind === "sent") {
      sentHere.current = true;
      pressed.say(WALLET_WORDS.payoutSent);
      return;
    }
    if (!pressed.latest()) return;
    pressed.say(
      sentHere.current
        ? WALLET_WORDS.payoutEarlierStands
        : sent.kind === "cancelled"
          ? WALLET_WORDS.payoutClosed
          : WALLET_WORDS.payoutFailed(sent.reason),
    );
  };
  return (
    <div className="lede">
      <div>
        <p>{WALLET_WORDS.payoutLead}</p>
        <p className="copy-row">
          <Button
            type="button"
            onPointerEnter={() => void coinbase().catch(() => undefined)}
            onFocus={() => void coinbase().catch(() => undefined)}
            onClick={() => void send()}
          >
            {WALLET_WORDS.payOut}
          </Button>
        </p>
        <p role="status">{said}</p>
      </div>
    </div>
  );
}
