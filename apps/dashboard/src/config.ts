/**
 * The environment goes through a schema, and the process names every problem at
 * once rather than one per restart. Secrets are read and never printed: a
 * startup failure names the variable that is wrong and never its value, because
 * a log goes places the environment does not.
 */

import { type SurfaceMode, surfaceModeOf } from "@agentify/core";
import { z } from "zod";
import { isSandboxMail, SANDBOX_MAIL } from "./mail.js";

const absentOrWrong = (whenWrong: string) => (issue: { input: unknown }) =>
  issue.input === undefined ? "the variable is not set" : whenWrong;

function isPostgresUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "postgres:" || protocol === "postgresql:";
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

/**
 * The length `openssl rand -base64 32` produces. It catches a placeholder left
 * in a file, not a weak choice.
 */
const SHORTEST_SECRET = 32;

/**
 * Addresses that mean "this machine" wherever a message is read. The public
 * address defaults to localhost for laptops, so a deployment that turns mail on
 * without setting it would send every merchant a link into their own computer.
 */
const NOWHERE_ELSE = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

const environmentSchema = z.object({
  /**
   * Neither has a default: this process describes money without moving it, and
   * falling back to play money could put a false sentence over real receipts.
   */
  PAYMENT_NETWORK: z.string({
    error: absentOrWrong("must be a CAIP-2 chain such as eip155:84532"),
  }),
  FACILITATOR_URL: z.string({ error: absentOrWrong("must be a string") }),
  DATABASE_URL: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(isPostgresUrl, "must be an address of the form postgres://user@host:port/database"),

  /**
   * Every link and form on every page is built from this; without it a merchant
   * at `/dashboard/cards` would be sent to `/cards`.
   */
  BASE_PATH: z
    .string()
    // A second slash or a backslash after the first is refused: "//evil.com"
    // and "/\evil.com" are protocol-relative URLs to a browser, and would send
    // every redirect, with the merchant's session following it, to another
    // host.
    .regex(/^(?:|\/(?![/\\])[^\s?#\\]*[^\s?#/\\])$/, 'must be empty or a path such as "/dashboard"')
    .default(""),

  /**
   * Off by default because a Secure cookie is never sent back over plain http
   * on localhost. Anywhere reachable over https it must be on, or the session
   * cookie travels in clear.
   */
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /**
   * No default, deliberately: the sign-in component has its own fallback, which
   * is a secret written in public source. Changing it signs everybody out and
   * nothing worse; it lets a hand-written cookie be refused before any query,
   * so the value never leaves this process.
   */
  AUTH_SECRET: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(
      (value) => value.length >= SHORTEST_SECRET,
      `must be at least ${SHORTEST_SECRET} characters; make one with: openssl rand -base64 32`,
    ),

  /** Bearer for the unproxied scanner-to-dashboard identity route. */
  REPORT_IDENTITY_SECRET: emptyIsAbsent(
    z
      .string()
      .refine(
        (value) => value.length >= SHORTEST_SECRET,
        `must be at least ${SHORTEST_SECRET} characters; make one with: openssl rand -base64 32`,
      ),
  ),

  /**
   * The address a merchant reaches this dashboard at, used only to build the
   * links in mail; every link on a page is relative. Behind a proxy the address
   * this process sees is not that one, so it is configured rather than read off
   * a request. A deployment sending real mail is refused while it is still the
   * localhost default.
   */
  PUBLIC_BASE_URL: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(isHttpUrl, "must be an address of the form https://agentify.example")
    .default("http://localhost:3001")
    .transform((value) => value.replace(/\/+$/, "")),

  /**
   * One value rather than a provider plus a sandbox flag, so the two cannot
   * disagree. The sandbox word writes every message, recipient and link
   * included, to the log.
   */
  MAIL_URL: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(
      (value) => isSandboxMail(value) || isHttpUrl(value),
      `must be the address of a mail provider, or "${SANDBOX_MAIL}" for a dashboard that sends nothing`,
    )
    .default(SANDBOX_MAIL),

  /** Nothing to set in the sandbox. */
  MAIL_API_KEY: emptyIsAbsent(z.string().min(1)),

  /**
   * Required when real mail is sent. Nothing reads replies, so the address
   * itself should say so.
   */
  MAIL_FROM: emptyIsAbsent(z.string().min(1)),
});

/**
 * A compose file hands a service a fixed list of names, so "not this one" is
 * written as the name with nothing after it; reading that as a value would
 * refuse it and stop the process.
 */
function emptyIsAbsent(rule: z.ZodType<string, string>) {
  return z
    .string()
    .optional()
    .transform((given) => (given === undefined || given === "" ? undefined : given))
    .pipe(z.union([z.undefined(), rule]));
}

export interface DashboardConfig {
  readonly surfaceMode: SurfaceMode;
  /**
   * The page a transaction on this deployment's chain is looked at on, which
   * its hash is appended to, or null where there is none: the sandbox settles
   * nothing, and a chain not listed here has no page we vouch for.
   */
  readonly transactionPage: string | null;
  /**
   * The page an address on this deployment's chain is looked at on, which the
   * address is appended to, or null where there is none, as for a transaction.
   * It is where a merchant sees what waits in their payout split, so a page on
   * the other chain would show an empty address as nothing owed.
   */
  readonly addressPage: string | null;
  /**
   * The EIP-155 chain a merchant's wallet is asked to work on, the payment
   * network's, or null in the sandbox, where no wallet is ever paid.
   */
  readonly walletChain: number | null;
  readonly basePath: string;
  readonly cookieSecure: boolean;
  readonly databaseUrl: string;
  /** Never printed, never on a page. */
  readonly authSecret: string;
  readonly reportIdentitySecret: string | null;
  readonly publicBaseUrl: string;
  readonly mailUrl: string;
  readonly mailApiKey: string | null;
  readonly mailFrom: string;
}

/** Used only in the sandbox, where messages go to the log. */
const NOBODY_READS_THIS = "Agentify <no-reply@localhost>";

/**
 * Where a transaction is looked at on each chain a gateway takes payments on,
 * Base and Base Sepolia.
 */
const TRANSACTION_PAGES: Readonly<Record<string, string>> = {
  "eip155:8453": "https://basescan.org/tx/",
  "eip155:84532": "https://sepolia.basescan.org/tx/",
};

/** Where an address is looked at on each of the same chains. */
const ADDRESS_PAGES: Readonly<Record<string, string>> = {
  "eip155:8453": "https://basescan.org/address/",
  "eip155:84532": "https://sepolia.basescan.org/address/",
};

/** The chain number of an `eip155:` network, or null for a network of another family. */
const eip155ChainOf = (network: string): number | null => {
  const chain = /^eip155:(\d+)$/.exec(network)?.[1];
  return chain === undefined ? null : Number(chain);
};

export function loadConfig(environment: Record<string, string | undefined>): DashboardConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const variable = issue.path.join(".");
      return variable === "" ? issue.message : `${variable}: ${issue.message}`;
    });
    throw new Error(
      `The dashboard cannot start, the configuration is incomplete — ${problems.join("; ")}`,
    );
  }

  const values = parsed.data;
  // A chain on neither known list leaves no honest mode to render.
  const surfaceMode = surfaceModeOf(values.PAYMENT_NETWORK, values.FACILITATOR_URL);
  const sandboxMail = isSandboxMail(values.MAIL_URL);
  const problems: string[] = [];

  // A credential beside the sandbox address is leftovers, most likely a
  // production environment file copied onto a sandbox, and is refused.
  if (sandboxMail && values.MAIL_API_KEY !== undefined) {
    problems.push(
      `MAIL_URL is ${JSON.stringify(SANDBOX_MAIL)}, which sends nothing anywhere, and` +
        " MAIL_API_KEY is set — that credential talks to a real provider, so one of the two is" +
        " left over from somewhere else",
    );
  }

  // A provider with no key would appear to send mail and silently not, which a
  // merchant discovers only when their sign-in link never arrives.
  if (!sandboxMail && values.MAIL_API_KEY === undefined) {
    problems.push(
      `MAIL_URL names a mail provider and MAIL_API_KEY is not set, so nothing would be accepted` +
        ` by it; set MAIL_URL to ${JSON.stringify(SANDBOX_MAIL)} for a dashboard that sends nothing`,
    );
  }

  if (!sandboxMail && values.MAIL_FROM === undefined) {
    problems.push(
      "MAIL_URL names a mail provider and MAIL_FROM is not set, so there is no address for a" +
        " message to come from",
    );
  }

  // Every link in every message would point at the reader's own computer.
  if (!sandboxMail && NOWHERE_ELSE.has(new URL(values.PUBLIC_BASE_URL).hostname)) {
    problems.push(
      `MAIL_URL names a mail provider and PUBLIC_BASE_URL is ${JSON.stringify(values.PUBLIC_BASE_URL)},` +
        " which means this machine wherever it is read — every link sent would point at the" +
        " reader's own computer",
    );
  }

  if (
    values.REPORT_IDENTITY_SECRET !== undefined &&
    [values.AUTH_SECRET, values.MAIL_API_KEY].includes(values.REPORT_IDENTITY_SECRET)
  ) {
    throw new Error(
      "The dashboard cannot start, REPORT_IDENTITY_SECRET must be dedicated to the private" +
        " report identity listener",
    );
  }

  if (problems.length > 0) {
    throw new Error(`The dashboard cannot start, the mail is not set up — ${problems.join("; ")}`);
  }

  return {
    surfaceMode,
    transactionPage:
      surfaceMode === "sandbox" ? null : (TRANSACTION_PAGES[values.PAYMENT_NETWORK] ?? null),
    addressPage: surfaceMode === "sandbox" ? null : (ADDRESS_PAGES[values.PAYMENT_NETWORK] ?? null),
    walletChain: surfaceMode === "sandbox" ? null : eip155ChainOf(values.PAYMENT_NETWORK),
    basePath: values.BASE_PATH,
    cookieSecure: values.COOKIE_SECURE,
    databaseUrl: values.DATABASE_URL,
    authSecret: values.AUTH_SECRET,
    reportIdentitySecret: values.REPORT_IDENTITY_SECRET ?? null,
    publicBaseUrl: values.PUBLIC_BASE_URL,
    mailUrl: values.MAIL_URL,
    mailApiKey: values.MAIL_API_KEY ?? null,
    mailFrom: values.MAIL_FROM ?? NOBODY_READS_THIS,
  };
}
