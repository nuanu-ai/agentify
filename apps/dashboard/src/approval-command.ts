import { printable } from "./printable.js";

export type ApprovalDirectoryEntry =
  | { readonly email: string; readonly binding: "unbound" }
  | { readonly email: string; readonly binding: "bound"; readonly merchantId: string };

export interface ApprovalDirectory {
  resolve(rawEmail: string): Promise<readonly ApprovalDirectoryEntry[]>;
}

/** Null where the gateway has no such merchant. */
type LiveApprovalChange = {
  readonly changed: boolean;
  readonly merchant: {
    readonly id: string;
    readonly serviceName: string | null;
    readonly liveApprovedAt: number | null;
  };
} | null;

/** The only gateway authority the private operator receives. */
export interface LiveApprovalPort {
  grant(merchantId: string): Promise<LiveApprovalChange>;
  withdraw(merchantId: string): Promise<LiveApprovalChange>;
}

export type ApprovalAction = "grant" | "withdraw";

/** What the terminal calls each action, and what it says came of it. */
const WORDS = {
  grant: {
    doing: "approval",
    title: "PRODUCTION live approval",
    changed: "approved now",
    unchanged: "already approved",
  },
  withdraw: {
    doing: "withdrawal",
    title: "PRODUCTION live approval withdrawal",
    changed: "approval withdrawn now; new live sales and publishing are refused",
    unchanged: "not approved, so there was nothing to withdraw",
  },
} as const;

export interface ApprovalTerminal {
  readonly say: (line: string) => void;
}

/**
 * Resolves one dashboard identity and grants or withdraws the live approval of
 * its existing gateway merchant.
 *
 * Every refusal before the gateway is asked is a known no-write result. Once it
 * has been asked, an exception is uncertain: the database may have committed
 * the write before the connection disappeared, so the honest instruction is to
 * repeat this idempotent command and inspect the result.
 */
export async function runApproval(
  rawEmail: string,
  directory: ApprovalDirectory,
  gateway: LiveApprovalPort,
  terminal: ApprovalTerminal,
  action: ApprovalAction,
): Promise<number> {
  const say = (line: string): void => terminal.say(printable(line));
  const words = WORDS[action];
  const refused = (why: string): number => {
    say(`PRODUCTION ${words.doing} refused: ${why}`);
    return 1;
  };

  let matches: readonly ApprovalDirectoryEntry[];
  try {
    matches = await directory.resolve(rawEmail);
  } catch {
    say(
      `PRODUCTION ${words.doing} could not inspect the dashboard accounts. No gateway write was requested.`,
    );
    return 1;
  }

  if (matches.length > 1) {
    return refused("more than one account matches that normalized email.");
  }
  const match = matches[0];
  if (match === undefined) {
    return refused("no account matches that normalized email.");
  }
  if (match.binding !== "bound") {
    return refused(`${match.email} has no merchant binding.`);
  }

  let answered: LiveApprovalChange;
  try {
    answered = await gateway[action](match.merchantId);
  } catch {
    say(
      `The PRODUCTION ${words.doing} outcome is unknown. Retry the same command to inspect the result.`,
    );
    return 1;
  }

  if (answered === null) {
    return refused(`dashboard merchant ${match.merchantId} does not exist in the gateway.`);
  }

  say(words.title);
  say(`Email: ${match.email}`);
  say(`Seller name: ${answered.merchant.serviceName ?? "not set"}`);
  say(`Merchant ID: ${answered.merchant.id}`);
  say(`Status: ${answered.changed ? words.changed : words.unchanged}`);
  return 0;
}
