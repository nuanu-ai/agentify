/**
 * What the dashboard asks a merchant's wallet, against a wallet that answers
 * as Coinbase Wallet's provider does: accounts on request, a chain it is
 * switched to, and a batch of calls it sends only on the chain it is on. The
 * promises are to the merchant: the box gets their wallet's address and
 * nothing else, the payout sent is the one the screen shows, on the channel's
 * chain, and a closed window reads as a closed window.
 */

import { describe, expect, it } from "vitest";
import { askAddress, sendPayout, type Wallet } from "./requests.js";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const DATA = "0x82ad56cb0000000000000000000000000000000000000000000000000000000000000020";
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

/** EIP-1193's refusal for a request the person turned down. */
const DECLINED = { code: 4001, message: "User rejected the request." };

interface Sent {
  readonly chainId: string;
  readonly from: string;
  readonly atomicRequired: boolean;
  readonly calls: readonly Readonly<{ to: string; value: string; data?: string }>[];
}

/**
 * A wallet as Coinbase Wallet's provider behaves: it starts on Base, keeps the
 * batches it sent, and refuses a batch for a chain it is not on.
 */
const wallet = ({
  accounts = [CHECKSUMMED.toLowerCase()],
  declines,
  breaks,
}: {
  readonly accounts?: unknown;
  readonly declines?: "eth_requestAccounts" | "wallet_sendCalls";
  readonly breaks?: string;
} = {}) => {
  let chain = "0x2105";
  const sent: Sent[] = [];
  const answering: Wallet = {
    async request({ method, params }) {
      if (method === declines) throw DECLINED;
      if (method === breaks) throw { code: -32603, message: "Something went wrong at Coinbase" };
      if (method === "eth_requestAccounts") return accounts;
      if (method === "wallet_switchEthereumChain") {
        chain = (params?.[0] as { chainId: string } | undefined)?.chainId ?? chain;
        return null;
      }
      if (method === "wallet_sendCalls") {
        const batch = params?.[0] as Sent & { version: string };
        if (batch.version !== "2.0.0") throw { code: -32602, message: "Unsupported version" };
        if (batch.chainId !== chain) throw { code: 4901, message: "Chain mismatch" };
        sent.push(batch);
        return { id: "0x00b47c4" };
      }
      throw { code: 4200, message: `Unsupported method ${method}` };
    },
  };
  return { answering, sent };
};

describe("asking the merchant's wallet for its address", () => {
  it("hands back the address in the spelling a wallet shows, whatever case the wallet answered in", async () => {
    const { answering } = wallet();

    expect(await askAddress(answering)).toEqual({ kind: "address", address: CHECKSUMMED });
  });

  it("reads a closed window as the merchant changing their mind, not as a failure", async () => {
    const { answering } = wallet({ declines: "eth_requestAccounts" });

    expect(await askAddress(answering)).toEqual({ kind: "cancelled" });
  });

  it("refuses an answer that is not an address rather than put it in the box", async () => {
    const { answering } = wallet({ accounts: ["not an address"] });

    const asked = await askAddress(answering);

    expect(asked.kind).toBe("failed");
  });

  it("refuses an answer that names no account", async () => {
    const { answering } = wallet({ accounts: [] });

    expect((await askAddress(answering)).kind).toBe("failed");
  });

  it("passes on the wallet's own words when it fails for a reason of its own", async () => {
    const { answering } = wallet({ breaks: "eth_requestAccounts" });

    expect(await askAddress(answering)).toEqual({
      kind: "failed",
      reason: "Something went wrong at Coinbase",
    });
  });
});

describe("sending the payout through the merchant's wallet", () => {
  const payout = { to: MULTICALL3, data: DATA };

  it("sends the transaction the screen shows, whole and carrying no money, on the test channel's chain", async () => {
    const { answering, sent } = wallet();

    expect(await sendPayout(answering, 84532, payout)).toEqual({ kind: "sent" });
    expect(sent).toEqual([
      expect.objectContaining({
        chainId: "0x14a34",
        from: CHECKSUMMED,
        calls: [{ to: MULTICALL3, value: "0x0", data: DATA }],
      }),
    ]);
  });

  it("sends it on Base for the live channel, never on the chain the wallet happened to be on", async () => {
    const { answering, sent } = wallet();

    await sendPayout(answering, 8453, payout);

    expect(sent.map((batch) => batch.chainId)).toEqual(["0x2105"]);
  });

  it("asks for the payout to happen whole or not at all", async () => {
    const { answering, sent } = wallet();

    await sendPayout(answering, 84532, payout);

    expect(sent[0]?.atomicRequired).toBe(true);
  });

  it("sends nothing and says the window was closed when the merchant declines to connect", async () => {
    const { answering, sent } = wallet({ declines: "eth_requestAccounts" });

    expect(await sendPayout(answering, 84532, payout)).toEqual({ kind: "cancelled" });
    expect(sent).toEqual([]);
  });

  it("says the window was closed when the merchant declines the payout itself", async () => {
    const { answering, sent } = wallet({ declines: "wallet_sendCalls" });

    expect(await sendPayout(answering, 84532, payout)).toEqual({ kind: "cancelled" });
    expect(sent).toEqual([]);
  });

  it("sends nothing on any chain when the wallet cannot be moved to the channel's", async () => {
    const { answering, sent } = wallet({ breaks: "wallet_switchEthereumChain" });

    expect(await sendPayout(answering, 84532, payout)).toEqual({
      kind: "failed",
      reason: "Something went wrong at Coinbase",
    });
    expect(sent).toEqual([]);
  });

  it("does not call a payout sent that the wallet refused to send", async () => {
    const { answering } = wallet({ breaks: "wallet_sendCalls" });

    expect((await sendPayout(answering, 84532, payout)).kind).toBe("failed");
  });
});
