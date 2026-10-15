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
    "The wallet is yours alone: nothing leaves it without your approval in Coinbase's window. Coinbase keeps no copy of your passkey or recovery key and cannot recover them, so keeping a way back into it is up to you.",
  manageAt: "https://wallet.coinbase.com",
  recoveryAt: "https://help.coinbase.com/en/wallet/getting-started/smart-wallet-recovery",
  waiting: "Waiting for Coinbase Wallet…",
  addressInTheBox:
    "Your Coinbase Wallet's address is in the box. Check it against the wallet, then save it; nothing has changed yet.",
  connectClosed: "Coinbase Wallet was closed. The box is as you left it.",
  connectLost:
    "Coinbase Wallet's answer was lost, as happens when another of its buttons is pressed while its window is open. Press again.",
  connectFailed: (reason: string) =>
    `Coinbase Wallet gave no address: ${reason}. You can still enter one by hand.`,
  payOut: "Pay out with Coinbase Wallet",
  payoutLead:
    "With a Coinbase Wallet you send it in one step: Coinbase's window asks you to approve it, and nothing is sent until you do.",
  payoutSent:
    "Coinbase Wallet sent the payout. Your payout contract's page shows once the network has carried it out.",
  payoutClosed: "Coinbase Wallet was closed. Nothing was sent.",
  payoutEarlierStands:
    "Coinbase Wallet sent nothing this time. It did send a payout from this page earlier.",
  payoutUnknown:
    "Coinbase Wallet did not tell this page whether a payout it was asked for went out. Check what your payout contract holds before sending another.",
  payoutFailed: (reason: string) =>
    `Coinbase Wallet did not send the payout: ${reason}. If your wallet holds nothing yet to pay the fee with, the payout arrives when Agentify next pays out every contract, on no set date.`,
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
 * Coinbase Wallet's SDK keeps one session with its window for the whole page,
 * and every press starts by ending it, so a press begun while another waits in
 * the window, of either button, leaves the waiting one unable to read its
 * answer, whatever the merchant did there. Presses of both buttons are counted
 * here together, so a press knows whether another has begun since it did.
 */
let begun = 0;

const begin = (): (() => boolean) => {
  begun += 1;
  const mine = begun;
  return () => mine === begun;
};

interface Pressed {
  /** No press of either button has begun since this one. */
  readonly alone: () => boolean;
  /** No press of this button has begun since this one. */
  readonly latest: () => boolean;
  readonly say: (said: string) => void;
}

/**
 * The status of a button's presses. A button is never held disabled while
 * Coinbase Wallet answers, because its window can vanish without answering,
 * as when a phone closes its tab, and a held button would then stay held; a
 * second press is taken instead.
 */
function usePresses(): [string, () => Pressed] {
  const [said, setSaid] = useState("");
  const counted = useRef(0);
  const press = (): Pressed => {
    counted.current += 1;
    const mine = counted.current;
    const alone = begin();
    setSaid(WALLET_WORDS.waiting);
    return { alone, latest: () => mine === counted.current, say: setSaid };
  };
  return [said, press];
}

/** Fills the box whose id is `box` with the wallet's address and leaves saving to the merchant. */
export function CoinbaseAddress({ chainId, box }: Readonly<{ chainId: number; box: string }>) {
  const runs = useScriptRuns();
  const [said, press] = usePresses();
  if (!runs) return null;
  const ask = async () => {
    const pressed = press();
    const asked = await coinbase()
      .then(({ askAddress, coinbaseWallet }) => askAddress(coinbaseWallet(chainId), pressed.alone))
      .catch(() => NOT_OPENED);
    if (!pressed.latest()) return;
    if (asked.kind === "address") {
      const field = document.getElementById(box);
      if (field instanceof HTMLInputElement) {
        field.value = asked.address;
        // A refusal of the address typed before would be read out against
        // this one, so it comes off the box until the next save is answered.
        if (field.getAttribute("aria-invalid") === "true") {
          const line = field.getAttribute("aria-describedby");
          for (const shown of [line, `${box}-refused`]) {
            if (shown !== null) document.getElementById(shown)?.setAttribute("hidden", "");
          }
          field.removeAttribute("aria-invalid");
          field.removeAttribute("aria-describedby");
        }
        field.focus();
      }
    }
    pressed.say(
      asked.kind === "address"
        ? WALLET_WORDS.addressInTheBox
        : asked.kind === "cancelled"
          ? WALLET_WORDS.connectClosed
          : asked.kind === "lost"
            ? WALLET_WORDS.connectLost
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
  const [said, press] = usePresses();
  const sentHere = useRef(false);
  const unknownHere = useRef(false);
  if (!runs) return null;
  const send = async () => {
    const pressed = press();
    const sent = await coinbase()
      .then(({ sendPayout, coinbaseWallet }) =>
        sendPayout(coinbaseWallet(chainId), chainId, payout, pressed.alone),
      )
      .catch(() => NOT_OPENED);
    // What the page says of payouts holds whichever press answers last: a
    // payout sent is said whenever it went out, and a press whose answer was
    // lost, or that another press overtook in the window, says the page does
    // not know, after which no press says that nothing was sent.
    if (sent.kind === "sent") {
      sentHere.current = true;
      pressed.say(WALLET_WORDS.payoutSent);
      return;
    }
    if (sent.kind === "lost" || !pressed.alone()) {
      unknownHere.current = true;
      pressed.say(WALLET_WORDS.payoutUnknown);
      return;
    }
    if (!pressed.latest()) return;
    pressed.say(
      unknownHere.current
        ? WALLET_WORDS.payoutUnknown
        : sentHere.current
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
