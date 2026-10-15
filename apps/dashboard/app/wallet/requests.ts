/**
 * What the dashboard asks a merchant's wallet, through its EIP-1193 provider:
 * the address for the payout wallet box, and the payout the screen shows, sent
 * once the merchant approves it in the wallet. Neither saves anything: the box
 * is saved by the merchant's own press, as an address typed by hand is.
 *
 * Each request starts and ends with the wallet disconnected. The provider
 * remembers the account it connected in the page's storage, across reloads and
 * across the dashboard's own accounts, and answers the next request for an
 * address from that memory without opening the wallet's window; on a shared
 * browser that would put one merchant's address into another's box.
 */

import { getAddress, isAddress } from "viem";

/** An EIP-1193 provider, as far as the dashboard uses one. */
export interface Wallet {
  request(asked: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  /** Forgets the connected account and the keys of the session with the wallet's window. */
  disconnect(): Promise<void>;
}

/** The merchant closed the wallet's window or declined; nothing happened. */
export interface Cancelled {
  readonly kind: "cancelled";
}

/** The wallet failed, in its own words where it gave any. */
export interface Failed {
  readonly kind: "failed";
  readonly reason: string;
}

/** EIP-1193's code for a request the person turned down. */
const DECLINED = 4001;

const outcomeOf = (thrown: unknown): Cancelled | Failed => {
  const { code, message } = (thrown ?? {}) as { code?: unknown; message?: unknown };
  if (code === DECLINED) return { kind: "cancelled" };
  return {
    kind: "failed",
    reason: typeof message === "string" && message !== "" ? message : "the wallet gave no reason",
  };
};

/**
 * The first account the wallet names, which for Coinbase Wallet is the wallet
 * itself, in the spelling a wallet shows (EIP-55), the one the saved address is
 * checked against by eye; anything that is not an address is refused rather
 * than passed on.
 */
const accountOf = async (wallet: Wallet): Promise<string> => {
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  const first = Array.isArray(accounts) ? (accounts[0] as unknown) : undefined;
  if (typeof first !== "string" || !isAddress(first)) {
    throw { message: "the wallet answered with no address" };
  }
  return getAddress(first);
};

/** `ask`, between two disconnections of the wallet, with what it threw read as an outcome. */
const forgotten = async <T>(
  wallet: Wallet,
  ask: () => Promise<T>,
): Promise<T | Cancelled | Failed> => {
  try {
    await wallet.disconnect();
    return await ask();
  } catch (thrown) {
    return outcomeOf(thrown);
  } finally {
    await wallet.disconnect().catch(() => undefined);
  }
};

export async function askAddress(
  wallet: Wallet,
): Promise<{ readonly kind: "address"; readonly address: string } | Cancelled | Failed> {
  return forgotten(
    wallet,
    async () => ({ kind: "address", address: await accountOf(wallet) }) as const,
  );
}

/**
 * Sends the payout as one call to its contract, carrying no money, on
 * `chainId`. The wallet is moved to that chain first, because a batch is sent
 * on the chain the wallet is on, and Multicall3 sits at the same address on
 * most chains: sent elsewhere, it can succeed, pay out nothing and still cost
 * a fee. `sent` means the wallet accepted the batch, not that the network has
 * included it.
 */
export async function sendPayout(
  wallet: Wallet,
  chainId: number,
  payout: Readonly<{ to: string; data: string }>,
): Promise<{ readonly kind: "sent" } | Cancelled | Failed> {
  const chain = `0x${chainId.toString(16)}`;
  return forgotten(wallet, async () => {
    const from = await accountOf(wallet);
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain }] });
    await wallet.request({
      method: "wallet_sendCalls",
      params: [
        {
          version: "2.0.0",
          from,
          chainId: chain,
          atomicRequired: true,
          calls: [{ to: payout.to, value: "0x0", data: payout.data }],
        },
      ],
    });
    return { kind: "sent" } as const;
  });
}
