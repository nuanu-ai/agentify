// @vitest-environment jsdom

/** The real request and component consume bounded provider answers; no wallet SDK or chain I/O. */
import { writeFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CoinbasePayout, WALLET_WORDS } from "./buttons.js";
import { sendPayout, type Wallet } from "./requests.js";

const selected = vi.hoisted(() => ({ wallet: undefined as Wallet | undefined }));
vi.mock("./coinbase.js", async () => ({
  ...(await import("./requests.js")),
  coinbaseWallet: () => {
    if (selected.wallet === undefined) throw new Error("campaign provider was not selected");
    return selected.wallet;
  },
}));

const ACCOUNT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const CHAIN = 84532;
const PAYOUT = {
  to: "0xcA11bde05977b3631167028862bE2a173976CA11",
  data: "0x82ad56cb0000000000000000000000000000000000000000000000000000000000000020",
};
const REASON = "fixture provider unavailable";
type Expected = "cancelled" | "failed" | "lost" | "sent" | "no_sent_claim";
interface Cell {
  readonly name: string;
  readonly expected: Expected;
  readonly at?: string;
  readonly thrown?: { readonly code: number; readonly message: string };
  readonly answer?: unknown;
  readonly knownFailure?: true;
  readonly proof: string;
}

const cells: readonly Cell[] = [
  {
    name: "account request rejected",
    expected: "cancelled",
    at: "eth_requestAccounts",
    thrown: { code: 4001, message: "User rejected the request." },
    proof: "the account request was rejected before a payout request",
  },
  {
    name: "payout request rejected",
    expected: "cancelled",
    at: "wallet_sendCalls",
    thrown: { code: 4001, message: "User rejected the request." },
    proof: "the provider reports that the payout request was rejected",
  },
  {
    name: "provider submission failure",
    expected: "failed",
    at: "wallet_sendCalls",
    thrown: { code: -32603, message: REASON },
    proof: "the provider reports its own failure",
  },
  {
    name: "submission answer lost",
    expected: "lost",
    at: "wallet_sendCalls",
    thrown: { code: 4100, message: "Invalid session: response could not be read" },
    proof: "the provider cannot read the answer; submission is unknown",
  },
  ...[
    { name: "null resolved answer", answer: null },
    { name: "absent resolved answer", answer: undefined },
    { name: "empty resolved object", answer: {} },
    { name: "numeric batch identifier", answer: { id: 7 } },
  ].map(
    ({ name, answer }): Cell => ({
      name,
      answer,
      expected: "no_sent_claim",
      knownFailure: true,
      proof: "the resolved answer contains no readable batch acknowledgment",
    }),
  ),
  {
    name: "accepted batch still pending",
    expected: "sent",
    answer: { id: `0x${"11".repeat(64)}` },
    proof: "the provider acknowledges the batch; execution is still pending",
  },
  {
    name: "submitted batch acknowledgment",
    expected: "sent",
    answer: { id: `0x${"22".repeat(64)}`, capabilities: {} },
    proof: "the provider acknowledges a submitted batch; no receipt is returned",
  },
];

const providerFor = (cell: Cell): Wallet => ({
  async disconnect() {},
  async request({ method }) {
    if (method === cell.at) throw cell.thrown;
    if (method === "eth_requestAccounts") return [ACCOUNT];
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "wallet_sendCalls") return cell.answer;
    throw new Error(`unexpected provider operation ${method}`);
  },
});

interface Observation {
  readonly id: string;
  readonly surface: string;
  readonly cell: string;
  readonly proof: string;
  readonly expected: Expected;
  readonly actual: unknown;
  readonly matched: boolean;
  readonly knownFailure: boolean;
}
const observations: Observation[] = [];

const recorded = (
  cell: Cell,
  index: number,
  surface: string,
  actual: unknown,
  matched: boolean,
) => {
  observations.push({
    id: `wallet-${surface}-${index + 1}`,
    surface,
    cell: cell.name,
    proof: cell.proof,
    expected: cell.expected,
    actual,
    matched,
    knownFailure: cell.knownFailure === true,
  });
};

describe("campaign: wallet request outcomes do not exceed the provider's proof", () => {
  for (const [index, cell] of cells.entries()) {
    const run = cell.knownFailure ? it.fails : it;
    run(`wallet-request-${index + 1}: ${cell.name}`, async () => {
      const outcome = await sendPayout(providerFor(cell), CHAIN, PAYOUT);
      const matched =
        cell.expected === "no_sent_claim"
          ? outcome.kind !== "sent"
          : outcome.kind === cell.expected;
      recorded(cell, index, "request", outcome, matched);
      if (cell.expected === "no_sent_claim") expect(outcome.kind).not.toBe("sent");
      else expect(outcome.kind).toBe(cell.expected);
      if (cell.expected === "failed") expect(outcome).toMatchObject({ reason: REASON });
    });
  }
});

afterEach(() => {
  cleanup();
  selected.wallet = undefined;
});

describe("campaign: payout component describes only the observed response", () => {
  for (const [index, cell] of cells.entries()) {
    const run = cell.knownFailure ? it.fails : it;
    run(`wallet-component-${index + 1}: ${cell.name}`, async () => {
      selected.wallet = providerFor(cell);
      render(<CoinbasePayout chainId={CHAIN} payout={PAYOUT} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: WALLET_WORDS.payOut }));
      });
      await waitFor(() => expect(screen.queryByText(WALLET_WORDS.waiting)).toBeNull());
      const said = screen.getByRole("status").textContent ?? "";
      const expected =
        cell.expected === "cancelled"
          ? WALLET_WORDS.payoutClosed
          : cell.expected === "failed"
            ? WALLET_WORDS.payoutFailed(REASON)
            : cell.expected === "lost"
              ? WALLET_WORDS.payoutUnknown
              : WALLET_WORDS.payoutSent;
      const matched =
        cell.expected === "no_sent_claim" ? said !== WALLET_WORDS.payoutSent : said === expected;
      recorded(cell, index, "component", { status: said }, matched);
      expect(said).toMatch(/\S/);
      if (cell.expected === "no_sent_claim") expect(said).not.toBe(WALLET_WORDS.payoutSent);
      else expect(said).toBe(expected);
    });
  }
});

afterAll(() => {
  const destination = process.env.AGENTIFY_WALLET_CAMPAIGN_EVIDENCE;
  if (destination !== undefined) {
    writeFileSync(
      destination,
      JSON.stringify({ logicalCases: observations.length, observations }, null, 2),
    );
  }
});
