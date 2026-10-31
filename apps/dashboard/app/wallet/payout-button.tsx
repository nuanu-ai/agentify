import { Button } from "@agentify/ui";
import { LIMIT, NOT_OPENED, UNCOUNTED, usePresses, useScriptRuns } from "./button-state.js";
import { type PagePresses, pressesOf } from "./presses.js";
import type { sendPayout } from "./requests.js";

const coinbase = () => import("./coinbase.js");

export const PAYOUT_WORDS = {
  waitingPayout:
    "Waiting for Coinbase Wallet. If its window closed without an answer, press again: a second payout pays out only what the first left.",
  payOut: "Pay out with Coinbase Wallet",
  payoutLead: "Coinbase's window asks you to approve the payout. Nothing is sent until you do.",
  /** `brings` is the amount the page showed, with its currency, or null where it did not know it. */
  payoutSent: (brings: string | null): string =>
    `Coinbase Wallet accepted the payout${brings === null ? "" : ` of ${brings}`}. It reaches your wallet once the network carries it out, and until then this page still counts it as waiting, so reload in a few minutes before you send another.`,
  payoutClosed: "Coinbase Wallet was closed before the payout was asked for. Nothing was sent.",
  payoutUnconfirmed:
    "Coinbase's window closed without confirming the payout. If you approved it there, it may still go out, and this page counts it as waiting until the network carries it out, so give it a few minutes and reload before you send another, from Coinbase Wallet or from another wallet with the values below.",
  payoutUnanswered: `Coinbase Wallet gave no answer within ${LIMIT}, so this page does not know whether the payout went out. Give it a few minutes and reload before you send another, from Coinbase Wallet or from another wallet with the values below.`,
  payoutEarlierStands:
    "Coinbase Wallet sent nothing this time. It accepted a payout from this page earlier, which this page counts as waiting until the network carries it out.",
  payoutUnknown:
    "Coinbase Wallet did not tell this page whether a payout it was asked for went out. Give it a few minutes and reload before you send another, from Coinbase Wallet or from another wallet with the values below.",
  payoutNotSent:
    "Coinbase Wallet stopped before the payout was asked for, so nothing was sent. Press again, or send the payout from another wallet with the values below.",
} as const;

/**
 * Sends `payout`, the transaction the screen shows, from the merchant's
 * Coinbase Wallet on `chainId`. `brings` is what the screen said it would
 * bring, with its currency, or null where it did not know.
 */
export function CoinbasePayout({
  chainId,
  payout,
  className,
  brings,
}: Readonly<{
  chainId: number;
  payout: Readonly<{ to: string; data: string }>;
  className?: string;
  brings: string | null;
}>) {
  const runs = useScriptRuns();
  const [said, press] = usePresses(PAYOUT_WORDS.waitingPayout);
  if (!runs) return null;
  const send = async () => {
    const pressed = press();
    let alone = UNCOUNTED;
    let page: PagePresses | null = null;
    let sent: Awaited<ReturnType<typeof sendPayout>> | typeof NOT_OPENED;
    try {
      const { sendPayout, coinbaseWallet } = await coinbase();
      const wallet = coinbaseWallet(chainId);
      page = pressesOf(wallet);
      alone = page.begin();
      page.payoutsWaiting += 1;
      sent = await sendPayout(wallet, chainId, payout, alone).finally(() => {
        if (page !== null) page.payoutsWaiting -= 1;
      });
    } catch {
      sent = NOT_OPENED;
    }
    // What the page says of payouts holds whichever press answers last: a
    // payout sent is said whenever it went out; a press whose payout was
    // asked for and not acknowledged, or that another press overtook in the
    // window, says the page does not know; and no press says that nothing was
    // sent while the page does not know or another payout press still waits,
    // whose payout can still go out.
    if (sent.kind === "sent") {
      if (page !== null) page.payoutSent = true;
      pressed.say(PAYOUT_WORDS.payoutSent(brings));
      return;
    }
    if (sent.kind === "unanswered") {
      if (page !== null) page.payoutUnknown = true;
      pressed.say(PAYOUT_WORDS.payoutUnanswered);
      void sent.late.then((acknowledged) => {
        if (!acknowledged) return;
        if (page !== null) page.payoutSent = true;
        pressed.say(PAYOUT_WORDS.payoutSent(brings));
      });
      return;
    }
    if (sent.kind === "unconfirmed" || sent.kind === "lost" || !alone()) {
      if (page !== null) page.payoutUnknown = true;
      pressed.say(
        sent.kind === "unconfirmed" ? PAYOUT_WORDS.payoutUnconfirmed : PAYOUT_WORDS.payoutUnknown,
      );
      return;
    }
    if (!pressed.latest()) return;
    pressed.say(
      page !== null && (page.payoutUnknown || page.payoutsWaiting > 0)
        ? PAYOUT_WORDS.payoutUnknown
        : page?.payoutSent === true
          ? PAYOUT_WORDS.payoutEarlierStands
          : sent.kind === "cancelled"
            ? PAYOUT_WORDS.payoutClosed
            : PAYOUT_WORDS.payoutNotSent,
    );
  };
  return (
    <div className={className}>
      <p className="copy-row">
        <Button
          type="button"
          onPointerEnter={() => void coinbase().catch(() => undefined)}
          onFocus={() => void coinbase().catch(() => undefined)}
          onClick={() => void send()}
        >
          {PAYOUT_WORDS.payOut}
        </Button>
        <span role="status">{said}</span>
      </p>
      <p>{PAYOUT_WORDS.payoutLead}</p>
    </div>
  );
}
