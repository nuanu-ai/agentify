/**
 * The internal route between the scanner and the dashboard. The dashboard holds
 * every identity and every session on the site, and the scanner never handles
 * a token or mints a session. Over this route, reachable only on the compose
 * network and authenticated by a secret the two processes share, the scanner
 * asks three things: send a link for this address with this destination; whose
 * session is this cookie, and is its account an operator; and, for a privacy
 * deletion, remove this person if they own no merchant.
 */

import { z } from "zod";

const operationIdSchema = z.uuid().refine((value) => value[14] === "7", "Expected UUIDv7");
const timestampSchema = z.iso.datetime({ offset: true });

const normalizedEmailSchema = z
  .email()
  .max(320)
  .refine(
    (value) => value === value.trim().normalize("NFKC").toLowerCase(),
    "Expected a normalized email",
  );

/**
 * The request a full-report link was asked for: the scanner's own identifier
 * for it, which the dashboard records with the token and then with the session
 * the link opens, and never reads.
 */
const reportRequestSchema = z.uuid();

/**
 * Where a link the scanner asks for leads: the full report of one named scan.
 * It is recorded with the token when the link is asked for; nothing in the
 * link is ever read as a destination.
 */
const reportDestinationSchema = z.object({ report: z.uuid() }).strict();

/**
 * The name the site's one session cookie travels under: with the `__Host-`
 * prefix over https and without it on the plain-http local origin, because the
 * prefix requires `Secure` and a Secure cookie is never sent back over http.
 */
export const sessionCookieName = (secure: boolean): string =>
  `${secure ? "__Host-" : ""}agentify.session_token`;

const SESSION_COOKIE_NAMES = new Set([sessionCookieName(true), sessionCookieName(false)]);

/**
 * Only the session cookie's pairs of a cookie header: the dashboard learns
 * nothing about the visitor's other cookies, and a browser carrying many of
 * them cannot push the header past the size this route reads.
 */
export const sessionCookiePairs = (header: string): string =>
  header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => SESSION_COOKIE_NAMES.has(pair.slice(0, pair.indexOf("="))))
    .join("; ");

/** The longest cookie header the scanner passes on: session pairs, bounded. */
export const SESSION_COOKIE_HEADER_MAX = 8_192;

export const sendReportLinkRequestSchema = z
  .object({
    operation: z.literal("send"),
    email: normalizedEmailSchema,
    destination: reportDestinationSchema,
    request: reportRequestSchema,
  })
  .strict();

export const sendReportLinkResponseSchema = z.union([
  z.object({ status: z.literal("accepted") }).strict(),
  z.object({ status: z.literal("cooldown"), retry_at: timestampSchema }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);

/**
 * Whose session this cookie is. `renew` is true only when the scanner can pass
 * a renewed cookie on to the browser: a reading may move the session's end,
 * and unless the renewed cookie reaches the browser it runs out thirty days
 * after sign-in however often its person came back. A page drawn on the server
 * cannot set a cookie, so it asks for a reading that moves nothing.
 */
export const readSessionRequestSchema = z
  .object({
    operation: z.literal("session"),
    cookie: z.string().max(SESSION_COOKIE_HEADER_MAX),
    renew: z.boolean(),
  })
  .strict();

export const readSessionResponseSchema = z.union([
  z
    .object({
      status: z.literal("signed_in"),
      email: normalizedEmailSchema,
      /**
       * Whether this session's account may read the operator's dashboard, as
       * the flag stands at this question.
       */
      operator: z.boolean(),
      /** The request the link that opened this session was asked for, if any. */
      request: reportRequestSchema.nullable(),
      /** The lines that renew the cookie, passed on as they are; empty when nothing moved. */
      set_cookie: z.array(z.string().max(4_096)).max(4),
    })
    .strict(),
  z.object({ status: z.literal("signed_out") }).strict(),
]);

export const deleteUnattachedPersonRequestSchema = z
  .object({
    operation: z.literal("delete"),
    operation_id: operationIdSchema,
    email: normalizedEmailSchema,
  })
  .strict();

export const deleteUnattachedPersonResponseSchema = z.union([
  z.object({ status: z.literal("deleted") }).strict(),
  z.object({ status: z.literal("already_absent") }).strict(),
  z.object({ status: z.literal("retained") }).strict(),
  z.object({ status: z.literal("refused") }).strict(),
]);

export const reportIdentityRequestSchema = z.union([
  sendReportLinkRequestSchema,
  readSessionRequestSchema,
  deleteUnattachedPersonRequestSchema,
]);

export type SendReportLinkRequest = z.infer<typeof sendReportLinkRequestSchema>;
export type SendReportLinkResponse = z.infer<typeof sendReportLinkResponseSchema>;
export type ReadSessionResponse = z.infer<typeof readSessionResponseSchema>;
export type DeleteUnattachedPersonRequest = z.infer<typeof deleteUnattachedPersonRequestSchema>;
export type DeleteUnattachedPersonResponse = z.infer<typeof deleteUnattachedPersonResponseSchema>;
