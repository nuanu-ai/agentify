/**
 * Making one call of the surface. Every address, method and answer document
 * comes from the route table in `@nuanu-ai/agentify-contracts`, and the key's
 * header is built by `merchantKeyHeaderValue` from the same package, so this
 * package writes down no path and no header of its own.
 *
 * The answer is read the same way whatever its HTTP status: the route's
 * document if it is one, otherwise the gateway's error envelope if it is one,
 * and only otherwise a failure this package describes itself, with the status.
 * A document is read with the contracts' reader rather than the closed schema
 * the gateway writes to, so a field added on a newer gateway is dropped and a
 * status word this package does not know reads `unknown`.
 *
 * Nothing here throws. A call comes back as the document or as a failure;
 * `client.ts` decides which failures a merchant sees returned and which
 * thrown. The body travels with a failure because a poll answer this SDK
 * cannot parse may still name the gateway's contract version.
 */

import {
  API_ROUTES,
  ErrorEnvelopeSchema,
  expandPath,
  MERCHANT_KEY_HEADER,
  merchantKeyHeaderValue,
  type Read,
  type RouteName,
  readerOf,
} from "@nuanu-ai/agentify-contracts";

/** Where the gateway is and which key opens its doors. */
export interface Gateway {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * The document a route answers with, as this package reads it, taken from the
 * schema the table names. It reads the shape of a parse result rather than
 * using zod's `infer`, because zod is not this package's to import (see
 * `schema.ts`).
 */
type DocumentOf<N extends RouteName> = (typeof API_ROUTES)[N]["response"] extends {
  document: { safeParse(value: unknown): infer Result };
}
  ? Result extends { success: true; data: infer Document }
    ? Read<Document>
    : never
  : never;

/**
 * What is known about whether the call got there. `not_received` is claimed
 * only where the network says plainly that nothing was handed over: the
 * connection was refused or the name did not resolve. Everything else without
 * a readable answer is `unknown`, so that a merchant never reconciles their
 * books from something this package made up.
 */
export const REACH = Object.freeze({
  /** No connection was made, so the gateway certainly has nothing. */
  NOT_RECEIVED: "not_received",
  /** The gateway answered, and the answer is not one this package can read. */
  ANSWERED: "answered",
  /**
   * The exchange was cut short, and what the call did is not known here. It
   * says nothing about direction: an abort may have fired before the request
   * left, a connection may have broken under way, or an answer may have
   * stopped arriving.
   */
  UNKNOWN: "unknown",
} as const);

export type Reach = (typeof REACH)[keyof typeof REACH];

/**
 * The network codes that mean nothing was handed over. Every other code reads
 * as unknown, so add one here only if it certainly means the request never
 * arrived.
 */
const NOTHING_WAS_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * The network's own codes for why a call failed. A name that resolves to
 * several addresses is tried at each and fails with one error holding the
 * others, so there can be several.
 */
const codesUnder = (cause: unknown): string[] => {
  const inner = (cause as { cause?: unknown })?.cause;
  const gathered = (inner as { errors?: unknown })?.errors;

  if (Array.isArray(gathered)) {
    return gathered
      .map((one) => (one as { code?: unknown })?.code)
      .filter((code): code is string => typeof code === "string");
  }

  const code = (inner as { code?: unknown })?.code;

  return typeof code === "string" ? [code] : [];
};

/**
 * What a failed `fetch` says about whether anything was handed over: nothing,
 * only where every address tried says so. Exported for its own test, which
 * can produce several addresses where a socket test cannot.
 */
export const reachOf = (cause: unknown): Reach => {
  const codes = codesUnder(cause);

  return codes.length > 0 && codes.every((code) => NOTHING_WAS_SENT.has(code))
    ? REACH.NOT_RECEIVED
    : REACH.UNKNOWN;
};

/** A call that did not produce the document the route promises. */
export interface TransportFailure {
  readonly route: RouteName;
  /** What happened, in one sentence, naming the route and the address. */
  readonly reason: string;
  /** What is known about whether the gateway got the call. */
  readonly reach: Reach;
  /**
   * The body, where it was JSON and was not the document. The poll loop looks
   * in it for the contract version, which tells a gateway of another version
   * apart from a broken one.
   */
  readonly body?: unknown;
  /**
   * The gateway's own refusal, present exactly when the body was the
   * contract's error envelope. Its code and `retryable` are carried as values
   * so a caller can branch without parsing prose, and `retryable` is the
   * gateway's own answer, which this package does not second-guess.
   */
  readonly refusal?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type Answer<N extends RouteName> =
  | { readonly ok: true; readonly document: DocumentOf<N> }
  | { readonly ok: false; readonly failure: TransportFailure };

export interface CallOptions {
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * How much of an unreadable answer is quoted back in the failure. A proxy's
 * error page often names what is broken, but a whole one can be a megabyte in
 * a merchant's log; what is cut is said in the same sentence.
 */
const QUOTED_CHARACTERS = 200;

const quote = (text: string): string =>
  text.length <= QUOTED_CHARACTERS
    ? JSON.stringify(text)
    : `${JSON.stringify(text.slice(0, QUOTED_CHARACTERS))} and ${text.length - QUOTED_CHARACTERS} more characters, not shown`;

/** The address of one call: the gateway's base, then the route's own path. */
const addressOf = (baseUrl: string, name: RouteName, path: CallOptions["path"]): string =>
  `${baseUrl.replace(/\/+$/, "")}${expandPath(API_ROUTES[name].path, path ?? {})}`;

const failure = (
  route: RouteName,
  reason: string,
  reach: Reach,
  body?: unknown,
  refusal?: TransportFailure["refusal"],
): { ok: false; failure: TransportFailure } => ({
  ok: false,
  failure: {
    route,
    reason,
    reach,
    ...(body === undefined ? {} : { body }),
    ...(refusal === undefined ? {} : { refusal }),
  },
});

/**
 * What is known about a failed call, as a clause to put before the failure's
 * own `reason`: one for each reach, and one for a refusal the gateway wrote in
 * words this package recognises.
 *
 * The clause for `unknown` covers three situations (an abort before sending, a
 * connection broken in flight, an answer cut off mid-way), so it claims only
 * that the exchange did not finish and what the call did is not known; the
 * `reason` that follows names which it was.
 */
export const whatIsKnown = (failure: TransportFailure): string => {
  // A refusal comes first: the gateway said what it would not do, and "what
  // came back could not be read" in front of its reason would contradict it.
  if (failure.refusal !== undefined) {
    return "it reached us and the answer says the call did not go through";
  }

  switch (failure.reach) {
    case REACH.NOT_RECEIVED:
      return "no connection was made, so it did not reach us";
    case REACH.ANSWERED:
      return "it reached us and what came back could not be read, so what it did is not known here";
    case REACH.UNKNOWN:
      return "the exchange did not finish, so what the call did is not known here";
  }
};

/**
 * One call, answered with the route's document or with a sentence about why
 * there is none.
 *
 * The cast at the end is safe though the compiler cannot follow it: for an
 * unresolved `name` the static type of the schema is a union of every route's,
 * while at runtime it is the right one.
 */
export const callRoute = async <N extends RouteName>(
  gateway: Gateway,
  name: N,
  options: CallOptions = {},
): Promise<Answer<N>> => {
  const route = API_ROUTES[name];
  const address = addressOf(gateway.baseUrl, name, options.path);
  const url = new URL(address);

  for (const [field, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(field, value);
  }

  const hasBody = route.method === "POST";

  let response: Response;

  try {
    response = await fetch(url, {
      method: route.method,
      headers: {
        accept: "application/json",
        [MERCHANT_KEY_HEADER]: merchantKeyHeaderValue(gateway.apiKey),
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(options.body ?? {}) } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    return failure(
      name,
      `${name} at ${url.href} could not be reached: ${String(cause)}`,
      reachOf(cause),
    );
  }

  let text: string;

  try {
    text = await response.text();
  } catch (cause) {
    // The gateway answered and the answer was not read to the end; calling it
    // "not JSON" would blame the gateway for a connection broken on our side.
    return failure(
      name,
      `${name} at ${url.href} began answering ${response.status} and the answer could not be read to the end: ${String(cause)}`,
      REACH.UNKNOWN,
    );
  }

  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    return failure(
      name,
      `${name} at ${url.href} answered ${response.status} with something that is not JSON: ${quote(text)}`,
      REACH.ANSWERED,
    );
  }

  const parsed = readerOf(route.response.document).safeParse(body);

  if (parsed.success) {
    return { ok: true, document: parsed.data as DocumentOf<N> };
  }

  // A body that is not the route's document may be the error envelope, and
  // then the caller gets what the gateway said. Refusals that live inside a
  // route's own document cannot be mistaken for it, because the envelope's
  // outer object is strict and those documents carry `ok`; a test in
  // `api.test.ts` holds that for every route. The HTTP status is not
  // consulted: which refusal arrives under which status is the gateway's.
  const refused = ErrorEnvelopeSchema.safeParse(body);

  if (refused.success) {
    const { code, message, retryable } = refused.data.error;

    return failure(
      name,
      `${name} at ${url.href} was refused ${response.status}: ${code} — ${message}`,
      REACH.ANSWERED,
      body,
      { code, message, retryable },
    );
  }

  return failure(
    name,
    `${name} at ${url.href} answered ${response.status} with something that is not the document it promises: ${quote(text)}`,
    REACH.ANSWERED,
    body,
  );
};
