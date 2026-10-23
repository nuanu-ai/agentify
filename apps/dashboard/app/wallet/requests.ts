/**
 * What the dashboard asks a merchant's wallet, through its EIP-1193 provider:
 * the address for the payout wallet box, and the payout the screen shows, sent
 * once the merchant approves it in the wallet. Neither saves anything: the box
 * is saved by the merchant's own press, as an address typed by hand is.
 *
 * Each request starts with the wallet disconnected, and ends so unless a later
 * request has begun. The provider remembers the account it connected in the
 * page's storage, across reloads and across the dashboard's own accounts, and
 * answers the next request for an address from that memory without opening
 * the wallet's window; on a shared browser that would put one merchant's
 * address into another's box. It also keeps one session with its window for
 * the whole page, so the disconnection a request starts with leaves an earlier
 * request still waiting unable to read its answer, which comes back `lost`, or
 * as a failure with no code where the browser's cryptography refuses it.
 */

import { getAddress, isAddress } from "viem";

/** An EIP-1193 provider, as far as the dashboard uses one. */
export interface Wallet {
  request(asked: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  /**
   * Forgets the connected account and the keys of the session with the
   * wallet's window. A provider a wallet's own browser injects may have none.
   */
  disconnect?(): Promise<void> | void;
}

/** The merchant closed the wallet's window or declined it before any payout was asked for; nothing happened. */
export interface Cancelled {
  readonly kind: "cancelled";
}

/**
 * The wallet failed before any payout was asked for. What it said of the
 * failure is not kept: a wallet's words, or the browser's where the wallet's
 * code itself broke, are not written for the merchant and can say something
 * untrue of the payout.
 */
export interface Failed {
  readonly kind: "failed";
}

/**
 * The wallet's answer could not be read, its session with the page gone or the
 * answer not one a wallet gives: what the merchant did in the wallet's window,
 * approving included, is unknown.
 */
export interface Lost {
  readonly kind: "lost";
}

/**
 * The wallet answered the payout with a refusal. A wallet's window can say it
 * was closed and still carry out what it was approved to do, so a refusal of
 * a payout already asked for does not show that nothing was sent.
 */
export interface Unconfirmed {
  readonly kind: "unconfirmed";
}

/** EIP-1193's code for a request the person turned down. */
const DECLINED = 4001;

/** EIP-1193's code for a request the provider is not authorised for, as an answer from a session it no longer has. */
const UNAUTHORISED = 4100;

const codeOf = (thrown: unknown): unknown =>
  typeof thrown === "object" && thrown !== null ? (thrown as { code?: unknown }).code : undefined;

const outcomeOf = (thrown: unknown): Cancelled | Failed | Lost => {
  const code = codeOf(thrown);
  if (code === DECLINED) return { kind: "cancelled" };
  if (code === UNAUTHORISED) return { kind: "lost" };
  return { kind: "failed" };
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
    throw new Error("the wallet answered with no address");
  }
  return getAddress(first);
};

/**
 * EIP-5792 acknowledges a batch with an object carrying its identifier; a
 * wallet answering an earlier version of it names the identifier alone.
 */
const namesABatch = (answer: unknown): boolean => {
  const id =
    typeof answer === "object" && answer !== null ? (answer as { id?: unknown }).id : answer;
  return typeof id === "string" && id !== "";
};

const disconnected = (wallet: Wallet): Promise<void> =>
  Promise.resolve()
    .then(() => wallet.disconnect?.())
    .catch(() => undefined);

/**
 * `ask` from a wallet just disconnected, with what it threw read as an outcome,
 * and the wallet disconnected again after unless `alone` says a later request
 * has begun, whose session that would end.
 */
const forgotten = async <T>(
  wallet: Wallet,
  alone: () => boolean,
  ask: () => Promise<T>,
): Promise<T | Cancelled | Failed | Lost> => {
  try {
    await disconnected(wallet);
    return await ask();
  } catch (thrown) {
    return outcomeOf(thrown);
  } finally {
    if (alone()) await disconnected(wallet);
  }
};

/** `alone` says whether no later request has begun on this page; by default none has. */
export async function askAddress(
  wallet: Wallet,
  alone: () => boolean = () => true,
): Promise<{ readonly kind: "address"; readonly address: string } | Cancelled | Failed | Lost> {
  return forgotten(
    wallet,
    alone,
    async () => ({ kind: "address", address: await accountOf(wallet) }) as const,
  );
}

/**
 * Sends the payout as one call to its contract, carrying no money, on
 * `chainId`. The wallet is moved to that chain first, because a batch is sent
 * on the chain the wallet is on, and Multicall3 sits at the same address on
 * most chains: sent elsewhere, it can succeed, pay out nothing and still cost
 * a fee. `sent` means the wallet acknowledged the batch, not that the network
 * has included it. Once the payout has been asked for, nothing the wallet
 * answers shows that it was not sent: a refusal is `unconfirmed`, and any
 * other failure, or an acknowledgment naming no batch, is `lost`.
 */
export async function sendPayout(
  wallet: Wallet,
  chainId: number,
  payout: Readonly<{ to: string; data: string }>,
  alone: () => boolean = () => true,
): Promise<{ readonly kind: "sent" } | Cancelled | Failed | Unconfirmed | Lost> {
  const chain = `0x${chainId.toString(16)}`;
  return forgotten(wallet, alone, async () => {
    const from = await accountOf(wallet);
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain }] });
    let acknowledged: unknown;
    try {
      acknowledged = await wallet.request({
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
    } catch (thrown) {
      return codeOf(thrown) === DECLINED
        ? ({ kind: "unconfirmed" } as const)
        : ({ kind: "lost" } as const);
    }
    return namesABatch(acknowledged) ? ({ kind: "sent" } as const) : ({ kind: "lost" } as const);
  });
}
