import { printable } from "./printable.js";

/** The dashboard-owned identity seam used by the private production operator. */
export type ApprovalDirectoryEntry =
  | { readonly email: string; readonly binding: "unbound" }
  | { readonly email: string; readonly binding: "bound"; readonly merchantId: string };

export interface ApprovalDirectory {
  resolve(rawEmail: string): Promise<readonly ApprovalDirectoryEntry[]>;
}

/** The only gateway authority the private operator receives. */
export interface LiveApprovalPort {
  grant(merchantId: string): Promise<{
    readonly changed: boolean;
    readonly merchant: {
      readonly id: string;
      readonly serviceName: string | null;
      readonly liveApprovedAt: number | null;
    };
  } | null>;
}

export interface ApprovalTerminal {
  readonly say: (line: string) => void;
}

/**
 * Resolves one dashboard identity and grants its existing gateway merchant.
 *
 * Every refusal before `grant` is a known no-write result. Once `grant` has
 * been called, an exception is uncertain: the database may have committed the
 * one-way write before the connection disappeared, so the honest instruction
 * is to repeat this idempotent command and inspect the result.
 */
export async function runApproval(
  rawEmail: string,
  directory: ApprovalDirectory,
  gateway: LiveApprovalPort,
  terminal: ApprovalTerminal,
): Promise<number> {
  const say = (line: string): void => terminal.say(printable(line));

  let matches: readonly ApprovalDirectoryEntry[];
  try {
    matches = await directory.resolve(rawEmail);
  } catch {
    say(
      "PRODUCTION approval could not inspect the dashboard accounts. No gateway write was requested.",
    );
    return 1;
  }

  if (matches.length === 0) {
    say("PRODUCTION approval refused: no account matches that normalized email.");
    return 1;
  }
  if (matches.length !== 1) {
    say("PRODUCTION approval refused: more than one account matches that normalized email.");
    return 1;
  }

  const match = matches[0];
  if (match === undefined) {
    say("PRODUCTION approval refused: no account matches that normalized email.");
    return 1;
  }
  if (match.binding !== "bound") {
    say(`PRODUCTION approval refused: ${match.email} has no merchant binding.`);
    return 1;
  }

  let granted: Awaited<ReturnType<LiveApprovalPort["grant"]>>;
  try {
    granted = await gateway.grant(match.merchantId);
  } catch {
    say(
      "The PRODUCTION approval outcome is unknown. Retry the same command to inspect the one-way result.",
    );
    return 1;
  }

  if (granted === null) {
    say(
      `PRODUCTION approval refused: dashboard merchant ${match.merchantId} does not exist in the gateway.`,
    );
    return 1;
  }

  say("PRODUCTION live approval");
  say(`Email: ${match.email}`);
  say(`Seller name: ${granted.merchant.serviceName ?? "not set"}`);
  say(`Merchant ID: ${granted.merchant.id}`);
  say(`Status: ${granted.changed ? "approved now" : "already approved"}`);
  return 0;
}
