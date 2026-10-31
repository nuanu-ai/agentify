import { Button } from "@agentify/ui";
import type { ReactNode } from "react";
import { usePresses, useScriptRuns } from "./button-state.js";

const addressCode = () => import("./address-answer.js");

export const ADDRESS_STATE = {
  waitingAddress:
    "Waiting for Coinbase Wallet. If its window closed without an answer, press again.",
  connectNotOpened: "This page couldn't open Coinbase Wallet. Press again, or paste an address.",
} as const;

/** Fills the box whose id is `box` with the wallet's address and leaves saving to the merchant. */
export function CoinbaseAddress({
  chainId,
  box,
  className,
  label,
  before,
  children,
}: Readonly<{
  chainId: number;
  box: string;
  className?: string;
  label: string;
  before?: ReactNode;
  children: ReactNode;
}>) {
  const runs = useScriptRuns();
  const [said, press] = usePresses(ADDRESS_STATE.waitingAddress);
  if (!runs) return null;
  const ask = async () => {
    const pressed = press();
    let address: Awaited<ReturnType<typeof addressCode>>;
    try {
      address = await addressCode();
    } catch {
      if (pressed.latest()) pressed.say(ADDRESS_STATE.connectNotOpened);
      return;
    }
    await address.chooseAddress(chainId, box, pressed, ADDRESS_STATE.connectNotOpened);
  };
  return (
    <div className={className}>
      <p className="copy-row">
        {before}
        <Button
          type="button"
          variant="secondary"
          onPointerEnter={() => void addressCode().catch(() => undefined)}
          onFocus={() => void addressCode().catch(() => undefined)}
          onClick={() => void ask()}
        >
          {label}
        </Button>
        <span role="status">{said}</span>
      </p>
      {children}
    </div>
  );
}
