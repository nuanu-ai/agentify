/**
 * The private production approval operation at its application boundary.
 *
 * The directory and gateway are ports here so these tests can prove the two
 * things the command itself owns: it refuses every uncertain identity before a
 * write, and it tells the operator exactly which existing seller the one-way
 * gateway operation changed. PostgreSQL coverage exercises the real resolver
 * and store together in approval-directory.db-test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  type ApprovalDirectory,
  type ApprovalDirectoryEntry,
  type LiveApprovalPort,
  runApproval,
} from "./approval-command.js";

const MERCHANT = "mch_the_existing_merchant";
const EMAIL = "merchant@example.com";

const bound = (email: string = EMAIL, merchantId: string = MERCHANT): ApprovalDirectoryEntry => ({
  email,
  binding: "bound",
  merchantId,
});

const directoryReturning = (
  entries: readonly ApprovalDirectoryEntry[],
): { readonly directory: ApprovalDirectory; readonly asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    directory: {
      resolve: async (rawEmail) => {
        asked.push(rawEmail);
        return entries;
      },
    },
  };
};

const gatewayReturning = (
  answer: {
    readonly changed: boolean;
    readonly merchant: {
      readonly id: string;
      readonly serviceName: string | null;
      readonly liveApprovedAt: number;
    };
  } | null,
): { readonly gateway: LiveApprovalPort; readonly granted: string[] } => {
  const granted: string[] = [];
  return {
    granted,
    gateway: {
      grant: async (merchantId) => {
        granted.push(merchantId);
        return answer;
      },
    },
  };
};

const run = async (
  rawEmail: string,
  directory: ApprovalDirectory,
  gateway: LiveApprovalPort,
): Promise<{
  readonly code: number;
  readonly output: string;
  readonly lines: readonly string[];
}> => {
  const lines: string[] = [];
  const code = await runApproval(rawEmail, directory, gateway, {
    say: (line) => lines.push(line),
  });
  return { code, output: lines.join("\n"), lines };
};

describe("the private production approval command", () => {
  it("grants the one merchant bound to the normalized cabinet address", async () => {
    const found = directoryReturning([bound()]);
    const granted = gatewayReturning({
      changed: true,
      merchant: {
        id: MERCHANT,
        serviceName: "The merchant's public name",
        liveApprovedAt: Date.parse("2026-09-17T10:00:00.000Z"),
      },
    });

    const result = await run("  Merchant@Example.COM\n", found.directory, granted.gateway);

    expect(result.code).toBe(0);
    expect(found.asked).toStrictEqual(["  Merchant@Example.COM\n"]);
    expect(granted.granted).toStrictEqual([MERCHANT]);
    expect(result.output).toMatch(/production/i);
    expect(result.output).toContain(EMAIL);
    expect(result.output).toContain("The merchant's public name");
    expect(result.output).toContain(MERCHANT);
    expect(result.output).toMatch(/approved now/i);
  });

  it("reports a grant the gateway says was already present", async () => {
    const found = directoryReturning([bound()]);
    const granted = gatewayReturning({
      changed: false,
      merchant: {
        id: MERCHANT,
        serviceName: null,
        liveApprovedAt: Date.parse("2026-09-16T09:00:00.000Z"),
      },
    });

    const result = await run(EMAIL, found.directory, granted.gateway);

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/already approved/i);
    expect(result.output).toMatch(/seller.*not set/i);
  });

  it.each([
    {
      case: "an address with no account",
      entries: [] as const,
      expected: /no account/i,
    },
    {
      case: "more than one normalized account row",
      entries: [bound(EMAIL, "mch_one"), bound(EMAIL, "mch_two")] as const,
      expected: /more than one|ambiguous/i,
    },
    {
      case: "an account with no merchant binding",
      entries: [{ email: EMAIL, binding: "unbound" }] as const,
      expected: /no merchant|not bound/i,
    },
    {
      case: "an account with only half of its merchant binding",
      entries: [{ email: EMAIL, binding: "partial" }] as const,
      expected: /partial|incomplete/i,
    },
  ])("refuses $case before asking the gateway to write", async ({ entries, expected }) => {
    const found = directoryReturning(entries);
    const granted = gatewayReturning({
      changed: true,
      merchant: {
        id: MERCHANT,
        serviceName: "A seller",
        liveApprovedAt: Date.parse("2026-09-17T10:00:00.000Z"),
      },
    });

    const result = await run(" Merchant@Example.COM ", found.directory, granted.gateway);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(expected);
    expect(granted.granted).toStrictEqual([]);
  });

  it("refuses a cabinet binding whose merchant is absent from the gateway", async () => {
    const found = directoryReturning([bound()]);
    const granted = gatewayReturning(null);

    const result = await run(EMAIL, found.directory, granted.gateway);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/merchant.*does not exist|missing.*merchant/i);
    expect(granted.granted).toStrictEqual([MERCHANT]);
  });

  it("does not disclose a database error or claim a result whose write is uncertain", async () => {
    const found = directoryReturning([bound()]);
    const secret = "postgres://operator:the-password@database/production";
    const gateway: LiveApprovalPort = {
      grant: async () => {
        throw new Error(`connection failed while using ${secret}`);
      },
    };

    const result = await run(EMAIL, found.directory, gateway);

    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toMatch(/approved now|already approved/i);
    expect(result.output).toMatch(/retry.*inspect|inspect.*retry/i);
  });

  it("renders every database-owned value inert in the operator's terminal", async () => {
    const dangerousEmail = "merchant@example.com\u001b[2J";
    const dangerousMerchant = "mch_one\rOVERWRITTEN";
    const dangerousName = "Seller\nAPPROVED";
    const found = directoryReturning([bound(dangerousEmail, dangerousMerchant)]);
    const granted = gatewayReturning({
      changed: true,
      merchant: {
        id: dangerousMerchant,
        serviceName: dangerousName,
        liveApprovedAt: Date.parse("2026-09-17T10:00:00.000Z"),
      },
    });

    const result = await run(EMAIL, found.directory, granted.gateway);

    expect(result.code).toBe(0);
    expect(result.output).not.toContain("\u001b");
    expect(result.output).not.toContain("\r");
    expect(result.output).not.toContain(dangerousName);
    expect(result.output).toContain("\\x1b");
    expect(result.output).toContain("\\x0d");
    expect(result.output).toContain("Seller\\x0aAPPROVED");
    expect(result.lines.every((line) => !line.includes("\u001b") && !line.includes("\r"))).toBe(
      true,
    );
  });
});
