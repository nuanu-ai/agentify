import { createHash } from "node:crypto";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import {
  scannerAuthAccounts,
  scannerAuthSessions,
  scannerAuthUsers,
  scannerAuthVerifications,
  type DatabaseTransaction,
} from "@agentify/scanner-database";
import { and, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { getServerConfig } from "./config";
import { getDatabase } from "./database";
import { sendTransactionalEmail } from "./email";

const LINK_TTL_SECONDS = 60 * 60;
export type ScannerMagicLinkPurpose = "registration" | "recovery";

export type ScannerMagicLinkClaim = Readonly<{
  email: string;
  purpose?: ScannerMagicLinkPurpose;
  state?: string;
}>;

function scannerAuth(tx?: DatabaseTransaction) {
  const config = getServerConfig();
  return betterAuth({
    baseURL: new URL("/api/scanner-auth", config.appBaseUrl).toString(),
    secret: createHash("sha256")
      .update(`${config.hmacSecret}:scanner-better-auth`)
      .digest("hex"),
    telemetry: { enabled: false },
    database: drizzleAdapter(tx ?? drizzle(getDatabase().pool), {
      provider: "pg",
      schema: {
        scanner_auth_users: scannerAuthUsers,
        scanner_auth_sessions: scannerAuthSessions,
        scanner_auth_accounts: scannerAuthAccounts,
        scanner_auth_verifications: scannerAuthVerifications,
      },
    }),
    user: { modelName: "scanner_auth_users" },
    session: {
      modelName: "scanner_auth_sessions",
      disableSessionRefresh: true,
    },
    account: { modelName: "scanner_auth_accounts" },
    verification: { modelName: "scanner_auth_verifications" },
    advanced: {
      cookiePrefix: "scanner-auth",
      defaultCookieAttributes: {
        path: "/auth",
        httpOnly: true,
        sameSite: "strict",
        secure: config.production,
      },
    },
    plugins: [
      magicLink({
        expiresIn: LINK_TTL_SECONDS,
        storeToken: "hashed",
        async sendMagicLink({ email, token, metadata }) {
          const state = metadata?.state;
          const purpose = metadata?.purpose;
          if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
            throw new Error("verification_state_missing");
          }
          if (purpose !== "registration" && purpose !== "recovery") {
            throw new Error("verification_purpose_missing");
          }
          const hash = createHash("sha256").update(token).digest("base64url");
          const database = tx ?? getDatabase().db;
          const stored = await database
            .update(scannerAuthVerifications)
            .set({ value: JSON.stringify({ email, purpose, state }) })
            .where(eq(scannerAuthVerifications.identifier, hash))
            .returning({ id: scannerAuthVerifications.id });
          if (!stored.length) throw new Error("verification_storage_missing");
          const link = new URL("/auth/callback", config.appBaseUrl);
          link.hash = new URLSearchParams({ state, token }).toString();
          const url = link.toString();
          await sendTransactionalEmail({
            to: email,
            subject:
              purpose === "recovery"
                ? "Recover your Agentify report"
                : "Confirm your Agentify registration",
            text: `Open this link and confirm your email to access your private report: ${url}`,
            html: `<p>Open this link and confirm your email to access your private report:</p><p><a href="${url}">Confirm email</a></p>`,
            evidenceUrl: url,
          });
        },
      }),
    ],
  });
}

let auth: ReturnType<typeof scannerAuth> | undefined;
const getAuth = () => (auth ??= scannerAuth());
const headers = () =>
  new Headers({ origin: new URL(getServerConfig().appBaseUrl).origin });

export async function sendScannerMagicLink(email: string, state: string) {
  await getAuth().api.signInMagicLink({
    body: { email, metadata: { purpose: "registration", state } },
    headers: headers(),
  });
}

export async function sendScannerRecoveryLink(email: string, state: string) {
  await getAuth().api.signInMagicLink({
    body: { email, metadata: { purpose: "recovery", state } },
    headers: headers(),
  });
}

export async function inspectScannerMagicLinkClaim(
  token: string,
  tx?: DatabaseTransaction,
): Promise<ScannerMagicLinkClaim | undefined> {
  if (!/^[A-Za-z0-9]{32}$/.test(token)) return undefined;
  const hash = createHash("sha256").update(token).digest("base64url");
  const db = tx ?? getDatabase().db;
  const row = (
    await db
      .select({ value: scannerAuthVerifications.value })
      .from(scannerAuthVerifications)
      .where(
        and(
          eq(scannerAuthVerifications.identifier, hash),
          gt(scannerAuthVerifications.expiresAt, new Date()),
        ),
      )
      .limit(1)
  )[0];
  if (!row) return undefined;
  try {
    const value: unknown = JSON.parse(row.value);
    if (
      typeof value === "object" &&
      value !== null &&
      "email" in value &&
      typeof value.email === "string"
    ) {
      const purpose =
        "purpose" in value &&
        (value.purpose === "registration" || value.purpose === "recovery")
          ? value.purpose
          : undefined;
      const state =
        "state" in value &&
        typeof value.state === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(value.state)
          ? value.state
          : undefined;
      return { email: value.email, purpose, state };
    }
  } catch {
    // A malformed verification never proves an address or a recovery purpose.
  }
  return undefined;
}

export async function inspectScannerMagicLink(
  token: string,
  tx?: DatabaseTransaction,
) {
  return (await inspectScannerMagicLinkClaim(token, tx))?.email;
}

export async function consumeScannerMagicLinkInTransaction(
  tx: DatabaseTransaction,
  token: string,
) {
  // A transaction-bound adapter makes Better Auth's token consumption, user
  // creation and session row part of the same commit as scanner registration.
  const result = await scannerAuth(tx).api.magicLinkVerify({
    query: { token },
    headers: headers(),
  });
  if (!result || !("user" in result) || !result.user?.emailVerified) {
    throw new Error("verification_invalid");
  }
  if ("session" in result && result.session?.token) {
    // The browser only receives the existing lead-bound report session.
    await tx
      .delete(scannerAuthSessions)
      .where(eq(scannerAuthSessions.token, result.session.token));
  }
  return { id: result.user.id, email: result.user.email };
}

export async function deleteScannerAuthUser(userId: string) {
  await getDatabase()
    .db.delete(scannerAuthUsers)
    .where(eq(scannerAuthUsers.id, userId));
}
