/**
 * What the dashboard asks a merchant's wallet, against a wallet that answers
 * as Coinbase Wallet's provider does: it opens its window for an account and
 * then remembers that account in the page, answering later requests from
 * memory until it is disconnected; it is switched to a chain and sends a batch
 * of calls only on the chain it is on. The promises are to the merchant: the
 * box gets the address of the wallet they chose in the window and nothing
 * else, the payout sent is the one the screen shows, on the channel's chain,
 * a payout is called not sent only when it was never asked for, and a window
 * that does not answer is waited for only so long.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { askAddress, sendPayout, type Wallet } from "./requests.js";
import { WALLET_ANSWERS_WITHIN_MS } from "./waiting.js";

afterEach(() => {
  vi.useRealTimers();
});

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
  throws,
  hangs,
  acknowledges = { id: "0x00b47c4" },
}: {
  readonly windows?: readonly unknown[];
  readonly startsOn?: string;
  readonly declines?: "eth_requestAccounts" | "wallet_sendCalls";
  readonly breaks?: string;
  /** A request whose answer the provider can no longer read, its session with the window gone. */
  readonly loses?: string;
  /** A request the provider answers by throwing `thrown`, which need not be an error EIP-1193 describes. */
  readonly throws?: Readonly<{ at: string; thrown: unknown }>;
  /**
   * A request whose window answers only when the test says, as a window left
   * open or one that vanished: `later` answers it as the wallet would have.
   */
  readonly hangs?: string;
  /** What the wallet answers once it has taken a batch. */
  readonly acknowledges?: unknown;
} = {}) => {
  let chain = startsOn;
  let remembered: unknown = null;
  let opened = 0;
  let keys = false;
  const sent: Sent[] = [];
  const later: { answer: () => void; refuse: () => void }[] = [];
  const asked: string[] = [];
  const answering: Wallet = {
    async request({ method, params }) {
      asked.push(method);
      if (method === hangs) {
        keys = true;
        return new Promise((resolve, reject) => {
          later.push({
            answer: () => {
              hangs = undefined;
              resolve(answering.request({ method, ...(params === undefined ? {} : { params }) }));
            },
            refuse: () => reject(DECLINED),
          });
        });
      }
      if (method === declines) throw DECLINED;
      if (method === throws?.at) throw throws.thrown;
      if (method === breaks) throw { code: -32603, message: "Something went wrong at Coinbase" };
      if (method === loses) {
        throw {
          code: 4100,
          message: "Invalid session: no shared secret found when decrypting response",
        };
      }
      if (method === "eth_requestAccounts") {
        if (remembered !== null) return remembered;
        keys = true;
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
        return acknowledges;
      }
      throw { code: 4200, message: `Unsupported method ${method}` };
    },
    async disconnect() {
      remembered = null;
      keys = false;
    },
  };
  return {
    answering,
    sent,
    remembered: () => remembered,
    /** Whether the keys of a session with the wallet's window are kept in the page. */
    keys: () => keys,
    later,
    /** Every method the page asked the wallet, in order, a late answer's own repeat included. */
    asked,
  };
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

  it("refuses an address whose capitals disagree with its checksum", async () => {
    const { answering } = wallet({ windows: [["0x5AAeb6053f3e94c9b9a09f33669435e7ef1beaed"]] });

    expect(await askAddress(answering)).toEqual({ kind: "failed" });
  });

  it("hands back none of the wallet's own words when it fails for a reason of its own", async () => {
    const { answering } = wallet({ breaks: "eth_requestAccounts" });

    expect(await askAddress(answering)).toEqual({ kind: "failed" });
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

  it("does not call a payout declined in the window not sent, since a refusal of it proves nothing either way", async () => {
    const { answering } = wallet({ declines: "wallet_sendCalls" });

    expect(await sendPayout(answering, 84532, payout)).toEqual({ kind: "unconfirmed" });
  });

  it("sends nothing on any chain when the wallet cannot be moved to the channel's", async () => {
    const { answering, sent } = wallet({ breaks: "wallet_switchEthereumChain" });

    expect(await sendPayout(answering, 84532, payout)).toEqual({ kind: "failed" });
    expect(sent).toEqual([]);
  });

  it("does not know whether a payout went out when the wallet's answer to it can no longer be read", async () => {
    const { answering } = wallet({ loses: "wallet_sendCalls" });

    expect(await sendPayout(answering, 84532, payout)).toEqual({ kind: "lost" });
  });

  it("does not know whether a payout went out when the wallet's acknowledgment names no batch", async () => {
    for (const acknowledges of [null, {}, { id: 7 }, { id: "" }]) {
      const { answering } = wallet({ acknowledges });

      expect(await sendPayout(answering, 84532, payout), JSON.stringify(acknowledges)).toEqual({
        kind: "lost",
      });
    }
  });

  it("calls a payout sent when the wallet names its batch on its own, as wallets answering an earlier version do", async () => {
    const { answering } = wallet({ acknowledges: "0x00b47c4" });

    expect(await sendPayout(answering, 84532, payout)).toEqual({ kind: "sent" });
  });

  it("does not call a payout sent that the wallet refused to send", async () => {
    const { answering } = wallet({ breaks: "wallet_sendCalls" });

    expect((await sendPayout(answering, 84532, payout)).kind).not.toBe("sent");
  });

  it("does not know whether a payout went out when the wallet's answer to it is a failure it cannot read", async () => {
    const thrown = [
      { message: "The operation failed for an operation-specific reason" },
      new TypeError("Cannot use 'in' operator to search for 'failure' in undefined"),
      undefined,
      "closed",
      { code: -32603, message: "Something went wrong at Coinbase" },
    ];
    for (const one of thrown) {
      const { answering } = wallet({ throws: { at: "wallet_sendCalls", thrown: one } });

      expect(await sendPayout(answering, 84532, payout), String(one)).toEqual({ kind: "lost" });
    }
  });
});

describe("waiting for the merchant's wallet", () => {
  const payout = { to: MULTICALL3, data: DATA };

  /** Whether `asking` has settled, once every answer already given has been read. */
  const settled = async (asking: Promise<unknown>): Promise<boolean> => {
    let done = false;
    void asking.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    return done;
  };

  it("waits ten minutes for a payout, as the page and the portal promise, and not a moment longer", async () => {
    vi.useFakeTimers();
    const { answering } = wallet({ hangs: "wallet_sendCalls" });

    const sending = sendPayout(answering, 84532, payout);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(await settled(sending)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect((await sending).kind).toBe("unanswered");
  });

  it("keeps waiting for an address until the limit, long enough to approve with a passkey", async () => {
    vi.useFakeTimers();
    const { answering } = wallet({ hangs: "eth_requestAccounts" });

    const asking = askAddress(answering);
    await vi.advanceTimersByTimeAsync(WALLET_ANSWERS_WITHIN_MS - 1);

    expect(await settled(asking)).toBe(false);
  });

  it("says no address came once the limit passes, and leaves no keys of the wallet's session in the page", async () => {
    vi.useFakeTimers();
    const { answering, keys } = wallet({ hangs: "eth_requestAccounts" });

    const asking = askAddress(answering);
    await vi.advanceTimersByTimeAsync(WALLET_ANSWERS_WITHIN_MS);

    expect(await asking).toEqual({ kind: "unanswered" });
    expect(keys()).toBe(false);
  });

  it("leaves the session to a press begun since when it stops waiting", async () => {
    vi.useFakeTimers();
    const { answering, keys } = wallet({ hangs: "eth_requestAccounts" });

    const asking = askAddress(answering, () => false);
    await vi.advanceTimersByTimeAsync(WALLET_ANSWERS_WITHIN_MS);

    expect((await asking).kind).toBe("unanswered");
    expect(keys()).toBe(true);
  });

  it("does not know whether a payout went out once the limit passes, and leaves no keys of the wallet's session in the page", async () => {
    vi.useFakeTimers();
    const { answering, keys } = wallet({ hangs: "wallet_sendCalls" });

    const sending = sendPayout(answering, 84532, payout);
    await vi.advanceTimersByTimeAsync(WALLET_ANSWERS_WITHIN_MS);

    expect((await sending).kind).toBe("unanswered");
    expect(keys()).toBe(false);
  });

  it.each([
    ["the account", "eth_requestAccounts"],
    ["the move to the payout's chain", "wallet_switchEthereumChain"],
  ])(
    "never asks for the payout once it has stopped waiting, even when %s comes late",
    async (_late, hangs) => {
      vi.useFakeTimers();
      const { answering, sent, later } = wallet({ hangs });

      const sending = sendPayout(answering, 84532, payout);
      await vi.advanceTimersByTimeAsync(WALLET_ANSWERS_WITHIN_MS);
      await sending;
      later[0]?.answer();
      await vi.advanceTimersByTimeAsync(0);

      expect(sent).toEqual([]);
    },
  );

  it("asks the wallet nothing more once it has stopped waiting, not even to move to the payout's chain", async () => {
    vi.useFakeTimers();
    const { answering, asked, later } = wallet({ hangs: "eth_requestAccounts" });

    const sending = sendPayout(answering, 84532, payout);
    await vi.advanceTimersByTimeAsync(WALLET_ANSWERS_WITHIN_MS);
    await sending;
    later[0]?.answer();
    await vi.advanceTimersByTimeAsync(0);

    expect(asked).not.toContain("wallet_switchEthereumChain");
  });

  it("says a payout the wallet acknowledges after the limit was sent", async () => {
    vi.useFakeTimers();
    const { answering, later } = wallet({ hangs: "wallet_sendCalls" });

    const sending = sendPayout(answering, 84532, payout);
    await vi.advanceTimersByTimeAsync(WALLET_ANSWERS_WITHIN_MS);
    const outcome = await sending;
    later[0]?.answer();

    expect(outcome.kind === "unanswered" && (await outcome.late)).toBe(true);
  });

  it("does not take a refusal after the limit for a payout sent or a payout not sent", async () => {
    vi.useFakeTimers();
    const { answering, later } = wallet({ hangs: "wallet_sendCalls" });

    const sending = sendPayout(answering, 84532, payout);
    await vi.advanceTimersByTimeAsync(WALLET_ANSWERS_WITHIN_MS);
    const outcome = await sending;
    later[0]?.refuse();

    expect(outcome.kind === "unanswered" && (await outcome.late)).toBe(false);
  });
});
