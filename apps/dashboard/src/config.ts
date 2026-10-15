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

  /**
   * Whether a registration made through a consented ad click is reported to
   * the ad tracker. The key and the receiver are held to their rules only once
   * this is on: a host keeps one environment file for every service, and a key
   * written there ahead of the switch must not stop the process.
   */
  REGISTRATION_POSTBACK_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  REGISTRATION_POSTBACK_KEY: emptyIsAbsent(z.string()),
  /** A laptop's own receiver; a deployment posts only to the tracker. */
  REGISTRATION_POSTBACK_URL: emptyIsAbsent(z.string()),
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
  /**
   * Where a consented registration is reported and the key it is reported
   * with, or null where nothing is reported. The key is never printed.
   */
  readonly registrationPostback: Readonly<{ endpoint: string; key: string }> | null;
}

/** The only address a deployment reports a registration to. */
const REGISTRATION_POSTBACK_ENDPOINT = "https://aisamuraihub.com/postback";

/** The tracker's own key, as it issued it, is at least this long. */
const SHORTEST_POSTBACK_KEY = 16;

/** The tracker's host and every name under it, a trailing dot included. */
function isTheTrackers(address: string): boolean {
  const host = new URL(address).hostname.replace(/\.$/, "");
  const tracker = new URL(REGISTRATION_POSTBACK_ENDPOINT).hostname;
  return host === tracker || host.endsWith(`.${tracker}`);
}

/** Used only in the sandbox, where messages go to the log. */
const NOBODY_READS_THIS = "Agentify <no-reply@localhost>";

/** Each chain a deployment may run on, and where a transaction on it is looked at. */
const TRANSACTION_PAGES: Readonly<Record<string, string>> = {
  "eip155:8453": "https://basescan.org/tx/",
  "eip155:84532": "https://sepolia.basescan.org/tx/",
  "eip155:11155111": "https://sepolia.etherscan.io/tx/",
  "eip155:80002": "https://amoy.polygonscan.com/tx/",
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

  const postback = values.REGISTRATION_POSTBACK_ENABLED
    ? registrationPostbackOf(surfaceMode, values, problems)
    : null;

  if (problems.length > 0) {
    throw new Error(
      `The dashboard cannot start, the configuration does not hold together — ${problems.join("; ")}`,
    );
  }

  return {
    surfaceMode,
    transactionPage:
      surfaceMode === "sandbox" ? null : (TRANSACTION_PAGES[values.PAYMENT_NETWORK] ?? null),
    basePath: values.BASE_PATH,
    cookieSecure: values.COOKIE_SECURE,
    databaseUrl: values.DATABASE_URL,
    authSecret: values.AUTH_SECRET,
    reportIdentitySecret: values.REPORT_IDENTITY_SECRET ?? null,
    publicBaseUrl: values.PUBLIC_BASE_URL,
    mailUrl: values.MAIL_URL,
    mailApiKey: values.MAIL_API_KEY ?? null,
    mailFrom: values.MAIL_FROM ?? NOBODY_READS_THIS,
    registrationPostback: postback,
  };
}

/**
 * The report's endpoint and key once it is switched on, or null with each
 * problem added to `problems`. None names a value: the key is a credential,
 * and a receiver's address says nothing a reader of the log needs.
 */
function registrationPostbackOf(
  surfaceMode: SurfaceMode,
  values: z.infer<typeof environmentSchema>,
  problems: string[],
): DashboardConfig["registrationPostback"] {
  const key = values.REGISTRATION_POSTBACK_KEY;
  const receiver = values.REGISTRATION_POSTBACK_URL;
  let endpoint: string | null = null;

  if (key === undefined || key.length < SHORTEST_POSTBACK_KEY) {
    problems.push(
      `REGISTRATION_POSTBACK_ENABLED is true and REGISTRATION_POSTBACK_KEY is ${key === undefined ? "not set" : `shorter than ${SHORTEST_POSTBACK_KEY} characters`},` +
        " so the tracker would turn every report away",
    );
  }

  if (surfaceMode === "test") {
    // The tracker would count a test registration as a real conversion.
    problems.push(
      "REGISTRATION_POSTBACK_ENABLED is true on the test channel, which never reports a" +
        " registration to the ad tracker",
    );
  } else if (surfaceMode === "live") {
    if (receiver === undefined) {
      endpoint = REGISTRATION_POSTBACK_ENDPOINT;
    } else {
      problems.push(
        "REGISTRATION_POSTBACK_URL is set on the live channel, which reports only to the" +
          " tracker's own address; the variable is for a laptop's receiver",
      );
    }
  } else if (receiver === undefined) {
    // A laptop reports only to a receiver of its own, so a registration made
    // while trying the page can never become somebody's conversion.
    problems.push(
      "REGISTRATION_POSTBACK_ENABLED is true on a sandbox and REGISTRATION_POSTBACK_URL is" +
        " not set, so there is no receiver of its own to report to",
    );
  } else if (!isHttpUrl(receiver)) {
    problems.push("REGISTRATION_POSTBACK_URL must be an http or https address");
  } else if (isTheTrackers(receiver)) {
    problems.push(
      "REGISTRATION_POSTBACK_URL names the ad tracker's host, and a sandbox reports only to a" +
        " receiver of its own",
    );
  } else {
    endpoint = receiver;
  }

  // Null whenever a problem was added, which the caller throws on.
  return endpoint === null || key === undefined ? null : { endpoint, key };
}
