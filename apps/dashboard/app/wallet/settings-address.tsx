import type { ComponentProps } from "react";
import { CoinbaseAddress } from "./address-button.js";

export const ADDRESS_WORDS = {
  connect: "Create or connect a Coinbase Wallet",
  connectLead:
    "Coinbase's window opens over this page. The wallet's address then comes into the box below, for you to save.",
  yours:
    "Only you can move money out of it. Coinbase can't recover it for you, so set up a way back in.",
  manageAt: "https://wallet.coinbase.com",
  recoveryAt: "https://help.coinbase.com/en/wallet/getting-started/smart-wallet-recovery",
} as const;

export function SettingsAddress(
  props: Omit<ComponentProps<typeof CoinbaseAddress>, "label" | "children" | "before">,
) {
  return (
    <CoinbaseAddress {...props} label={ADDRESS_WORDS.connect}>
      <p>
        {ADDRESS_WORDS.connectLead} {ADDRESS_WORDS.yours}{" "}
        <a href={ADDRESS_WORDS.manageAt} rel="noreferrer">
          Manage your wallet
        </a>{" "}
        ·{" "}
        <a href={ADDRESS_WORDS.recoveryAt} rel="noreferrer">
          How recovery works
        </a>
      </p>
    </CoinbaseAddress>
  );
}
