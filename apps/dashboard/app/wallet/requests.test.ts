/**
 * What the dashboard asks a merchant's wallet, against a wallet that answers
 * as Coinbase Wallet's provider does: it opens its window for an account and
 * then remembers that account in the page, answering later requests from
 * memory until it is disconnected; it is switched to a chain and sends a batch
 * of calls only on the chain it is on. The promises are to the merchant: the
 * box gets the address of the wallet they chose in the window and nothing
 * else, the payout sent is the one the screen shows, on the channel's chain,
 * and a closed window reads as a closed window.
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
 * A wallet as Coinbase Wallet's provider behaves. Each window it opens answers
 * with the next of `windows`, and the account it answered is then remembered
 * in the page, as the provider keeps it in the page's storage, and returned
 * without a window until `disconnect`. It starts on `startsOn`, keeps the
 * batches it sent, and refuses a batch for a chain it is not on.
 */
const wallet = ({
  windows = [[CHECKSUMMED.toLowerCase()]],
  startsOn = "0x2105",
  declines,
  breaks,
  loses,
}: {
  readonly windows?: readonly unknown[];
  readonly startsOn?: string;
  readonly declines?: "eth_requestAccounts" | "wallet_sendCalls";
  readonly breaks?: string;
  /** A request whose answer the provider can no longer read, its session with the window gone. */
  readonly loses?: string;
} = {}) => {
  let chain = startsOn;
  let remembered: unknown = null;
  let opened = 0;
  const sent: Sent[] = [];
  const answering: Wallet = {
    async request({ method, params }) {
      if (method === declines) throw DECLINED;
      if (method === breaks) throw { code: -32603, message: "Something went wrong at Coinbase" };
      if (method === loses) {
        throw {
          code: 4100,
          message: "Invalid session: no shared secret found when decrypting response",
        };
      }
      if (method === "eth_requestAccounts") {
        if (remembered !== null) return remembered;
        remembered = windows[Math.min(opened, windows.length - 1)];
        opened += 1;
        return remembered;
      }
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
    async disconnect() {
      remembered = null;
    },
  };
  return { answering, sent, remembered: () => remembered };
};

describe("asking the merchant's wallet for its address", () => {
  it("hands back the address in the spelling a wallet shows, whatever case the wallet answered in", async () => {
    const { answering } = wallet();

    expect(await askAddress(answering)).toEqual({ kind: "address", address: CHECKSUMMED });
  });

  it("asks the wallet's window on every press, never taking an account an earlier press left in the page", async () => {
    const other = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
    const { answering } = wallet({ windows: [[CHECKSUMMED.toLowerCase()], [other.toLowerCase()]] });

    await askAddress(answering);

    expect(await askAddress(answering)).toEqual({ kind: "address", address: other });
  });

  it("leaves no account remembered in the page once it has the address", async () => {
    const { answering, remembered } = wallet();

    await askAddress(answering);

    expect(remembered()).toBeNull();
  });

  it("leaves the session to a press begun since rather than ending it under that press", async () => {
    const { answering, remembered } = wallet();

    await askAddress(answering, () => false);

    expect(remembered()).not.toBeNull();
  });

  it("works with a wallet that has no way to be disconnected", async () => {
    const { answering } = wallet();
    const plain: Wallet = { request: (asked) => answering.request(asked) };

    expect(await askAddress(plain)).toEqual({ kind: "address", address: CHECKSUMMED });
  });

  it("reads an answer the wallet can no longer read as not knowing, not as a failure", async () => {
    const { answering } = wallet({ loses: "eth_requestAccounts" });

    expect(await askAddress(answering)).toEqual({ kind: "lost" });
  });

  it("reads a closed window as the merchant changing their mind, not as a failure", async () => {
    const { answering } = wallet({ declines: "eth_requestAccounts" });

    expect(await askAddress(answering)).toEqual({ kind: "cancelled" });
  });

  it("refuses an answer that is not an address rather than put it in the box", async () => {
    const { answering } = wallet({ windows: [["not an address"]] });

    const asked = await askAddress(answering);

    expect(asked.kind).toBe("failed");
  });

  it("refuses an answer that names no account", async () => {
    const { answering } = wallet({ windows: [[]] });

    expect((await askAddress(answering)).kind).toBe("failed");
  });

  it("refuses an address whose capitals disagree with its checksum, in words of its own", async () => {
    const { answering } = wallet({ windows: [["0x5AAeb6053f3e94c9b9a09f33669435e7ef1beaed"]] });

    expect(await askAddress(answering)).toEqual({
      kind: "failed",
      reason: "the wallet answered with no address",
    });
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
    const { answering, sent } = wallet({ startsOn: "0x14a34" });

    await sendPayout(answering, 8453, payout);

    expect(sent.map((batch) => batch.chainId)).toEqual(["0x2105"]);
  });

  it("leaves no account remembered in the page once the payout is sent", async () => {
    const { answering, remembered } = wallet();

    await sendPayout(answering, 84532, payout);

    expect(remembered()).toBeNull();
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

  it("does not know whether a payout went out when the wallet's answer to it can no longer be read", async () => {
    const { answering } = wallet({ loses: "wallet_sendCalls" });

    expect(await sendPayout(answering, 84532, payout)).toEqual({ kind: "lost" });
  });

  it("does not call a payout sent that the wallet refused to send", async () => {
    const { answering } = wallet({ breaks: "wallet_sendCalls" });

    expect((await sendPayout(answering, 84532, payout)).kind).toBe("failed");
  });
});
