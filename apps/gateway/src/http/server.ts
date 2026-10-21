/**
 * The HTTP surface, mounted from the contract's route table
 * (`packages/contracts/src/api.ts`); nothing here writes an address, a method
 * or a schema of its own. A route with no handler stops the gateway from
 * starting, and a route whose door is undecided is never mounted.
 *
 * Which door a call is behind is read off the route's `auth` and never off its
 * address: the address prefixes happen to line up with the doors today, but
 * that is not a rule. So there is no path-scoped middleware, and a new auth
 * mode stops the build until somebody says which door it is.
 */

import { environmentOfKeyPrefix, keyPrefixFor, SITES } from "@agentify/core";
import { telemetry } from "@agentify/observability/source";
import {
  type AuthMode,
  type ErrorCode,
  type ErrorEnvelope,
  MERCHANT_KEY_HEADER,
  merchantKeyFrom,
  mountableRoutes,
  type RouteDefinition,
  type RouteName,
} from "@nuanu-ai/agentify-contracts";
import express, { type Express, type Request, type Response } from "express";
import type { ZodType } from "zod";
import type { Gateway } from "../app/gateway.js";
import { checksBeforeSending } from "../app/written.js";
import { failureNamed } from "../failure-named.js";
import { GATEWAY_FAILED } from "./merchant-answers.js";
import { handlersFor } from "./routes.js";

export type RouteAnswer =
  | { readonly status: number; readonly document: unknown }
  /** The handler wrote the response itself: a refusal or the payment exchange. */
  | { readonly written: true };

export interface RouteCall {
  readonly params: Readonly<Record<string, string>>;
  /** The body, already held to the route's schema unless it checks its own. */
  readonly body: unknown;
  readonly query: unknown;
  /**
   * Whose key opened this call. On a route behind the merchant's key it is
   * always a merchant that exists; null on a route that takes no key.
   */
  readonly merchantId: string | null;
  /**
   * Which key opened this call, resolved in the same lookup as the merchant so
   * the two cannot disagree. A merchant may not disable the key their own call
   * was made with. Null on a route that takes no key.
   */
  readonly keyId: string | null;
  readonly request: Request;
  readonly response: Response;
}

export type RouteHandler = (call: RouteCall) => Promise<RouteAnswer>;

export interface MountedRoute {
  readonly serve: RouteHandler;
  /**
   * The body reaches this handler unchecked. Publishing a card reports every
   * problem as findings in its own answer; the purchase treats an unpaid call
   * with no document as the probe, not a mistake.
   */
  readonly checksItsOwnBody?: boolean;
}

/** The most a request body may be. A card with a large schema is still small. */
const BODY_LIMIT = "256kb";

/**
 * The whole surface, on an express app. Only tests pass `routes`; a deployment
 * mounts the contract's own list.
 */
export function buildApp(
  gateway: Gateway,
  routes: readonly [RouteName, RouteDefinition][] = mountableRoutes(),
): Express {
  const app = express();
  app.use((request, response, next) => {
    telemetry.observeHttp("gateway", request, response, () =>
      typeof request.route?.path === "string" ? request.route.path : "unmatched",
    );
    next();
  });
  const handlers = handlersFor(gateway);

  // Only affects the client address in logs: the challenge names the public
  // address from configuration, never from the request.
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use(express.json({ limit: BODY_LIMIT }));

  app.get("/healthz", (_request, response) => {
    response.json({ ok: true });
  });

  // An agent given only the site tries the storefront's root first. The
  // catalog is not a paid resource, so the redirect gives nothing listed a
  // second address.
  app.get("/x402", (_request, response) => {
    response.redirect(302, "/x402/catalog");
  });

  for (const [name, route] of routes) {
    // The contract's list already leaves these out; this guards against a
    // caller passing one in by name.
    if (route.auth === "undecided") {
      throw new Error(
        `the contract leaves ${name}'s door undecided, so this gateway will not serve it at ${route.method} ${route.path}`,
      );
    }
    const handler = handlers[name];
    if (handler === undefined) {
      throw new Error(
        `the contract's route table names ${name} at ${route.method} ${route.path} and this gateway has nothing to serve it with`,
      );
    }
    mount(app, name, route, handler, gateway);
  }

  app.use((_request, response) => {
    response.status(404).json(refusal("no_such_route", "there is no call at this address"));
  });

  // Everything refused before a route runs arrives here; without this it would
  // go out as express's HTML page. A 4xx from whatever threw is the caller's
  // fault and must not become a 5xx, which an agent would retry forever. Any
  // other throw is ours: logged, and answered 500.
  //
  // The named refusals refine the 4xx by the parser's own `type`, so each
  // answer names the actual problem (the size limit, the refused header).
  // A body that failed to decompress carries no type: whether the bytes or the
  // header is wrong is unknown, so the answer offers both. Order matters:
  // named cases come first, so a body that inflates cleanly but holds bad JSON
  // still gets the malformed-JSON answer, and an unrecognised refusal falls to
  // the generic answer rather than a guess.
  app.use(
    (thrown: unknown, request: Request, response: Response, next: (error?: unknown) => void) => {
      if (response.headersSent) {
        next(thrown);
        return;
      }

      if (blamesTheCaller(thrown)) {
        const named = refusalType(thrown);

        if (named === "entity.parse.failed") {
          response
            .status(400)
            .json(refusal("malformed_body", "this call's body could not be read as JSON"));
          return;
        }
        if (named === "entity.too.large") {
          response
            .status(413)
            .json(
              refusal(
                "body_too_large",
                `this call's body is over the ${BODY_LIMIT} a call may carry`,
              ),
            );
          return;
        }
        if (named === "charset.unsupported") {
          response
            .status(415)
            .json(
              refusal(
                "charset_unsupported",
                "this call's body was not read because the charset its content-type names is not one this gateway decodes, so send it as utf-8",
              ),
            );
          return;
        }
        if (named === "encoding.unsupported") {
          response
            .status(415)
            .json(
              refusal(
                "encoding_unsupported",
                "this call's body was not read because its content-encoding is not one this gateway decompresses, so send the body uncompressed",
              ),
            );
          return;
        }
        if (declaresCompression(request)) {
          response
            .status(400)
            .json(
              refusal(
                "body_undecodable",
                "this call's body could not be decompressed as the content-encoding it declares, so either those bytes or that header is wrong",
              ),
            );
          return;
        }

        response
          .status(400)
          .json(
            refusal(
              "call_refused",
              "this call was refused before the gateway began handling it, for a reason this gateway has no name for",
            ),
          );
        return;
      }

      console.error(
        `[gateway] a request failed before it reached a route: ${failureNamed(thrown)}`,
      );
      response
        .status(GATEWAY_FAILED.status)
        .json(refusal(GATEWAY_FAILED.code, GATEWAY_FAILED.message));
    },
  );

  return app;
}

function mount(
  app: Express,
  name: RouteName,
  route: RouteDefinition,
  handler: MountedRoute,
  gateway: Gateway,
): void {
  const methods = [route.method, ...(route.also_answers_on ?? [])];

  for (const method of methods) {
    // Only the route's own method carries a body; the others (a validator's
    // GET on a paid resource) answer without one.
    const carriesBody = method === route.method;
    const serve = async (request: Request, response: Response): Promise<void> => {
      try {
        await answer(request, response, route, handler, gateway, carriesBody);
      } catch (thrown) {
        console.error(`[gateway] ${name} failed: ${failureNamed(thrown)}`);
        if (!response.headersSent) {
          response
            .status(GATEWAY_FAILED.status)
            .json(refusal(GATEWAY_FAILED.code, GATEWAY_FAILED.message));
        }
      }
    };

    // Exhaustive, so a new method in the contract stops the build instead of
    // being mounted as something else.
    switch (method) {
      case "GET":
        app.get(route.path, serve);
        break;
      case "POST":
        app.post(route.path, serve);
        break;
      default: {
        const unmounted: never = method;
        throw new Error(`this gateway mounts no route on ${String(unmounted)}`);
      }
    }
  }
}

async function answer(
  request: Request,
  response: Response,
  route: RouteDefinition,
  handler: MountedRoute,
  gateway: Gateway,
  carriesBody: boolean,
): Promise<void> {
  const caller = await callerBehind(route.auth, request, gateway);
  if (caller === OTHER_ENVIRONMENT_PREFIX) {
    // Same code and status as any refusal at this door; only the sentence says
    // where such keys work. No lookup happened, so it claims no more than the
    // prefix proves.
    const theirs = gateway.environment === "live" ? "test" : "live";
    response
      .status(401)
      .json(
        refusal(
          "not_authorised",
          `this value begins with ${keyPrefixFor(theirs)}; ` +
            `keys with that prefix work on ${SITES[theirs]}`,
        ),
      );
    return;
  }
  if (caller === REFUSED) {
    // One answer for no key, an unknown key and a revoked key, so a guesser
    // learns nothing.
    response.status(401).json(refusal("not_authorised", "this call is behind the merchant's key"));
    return;
  }

  let body: unknown = carriesBody ? request.body : undefined;
  if (carriesBody && route.request !== undefined && handler.checksItsOwnBody !== true) {
    const held = hold(route.request, request.body);
    if (!held.ok) {
      response
        .status(400)
        .json(
          refusal(
            "malformed_body",
            "this call's body is not the document this call takes, and the problems say which fields and why",
            { problems: held.problems },
          ),
        );
      return;
    }
    body = held.value;
  }

  let query: unknown;
  if (route.query !== undefined) {
    const held = hold(route.query, request.query);
    if (!held.ok) {
      response
        .status(400)
        .json(
          refusal(
            "malformed_query",
            "this call's query string is not the one this call takes, and the problems say which fields and why",
            { problems: held.problems },
          ),
        );
      return;
    }
    query = held.value;
  }

  const answered = await handler.serve({
    params: request.params as Record<string, string>,
    body,
    query,
    merchantId: caller?.merchantId ?? null,
    keyId: caller?.keyId ?? null,
    request,
    response,
  });

  if ("written" in answered) {
    return;
  }

  // The document is held to the contract's schema on the way out, so a
  // mismatch fails here rather than in somebody's integration; a storefront
  // document is also held to its closed form (`written.ts`).
  for (const check of checksBeforeSending(route.response.document)) {
    check.parse(answered.document);
  }

  response.status(answered.status).json(answered.document);
}

/** The door said no. Not null, which is what an open route has. */
const REFUSED = Symbol("the key on this call opens nothing");

/** The value on this call begins with the other site's key prefix. */
const OTHER_ENVIRONMENT_PREFIX = Symbol("the value begins with the other site's key prefix");

interface Caller {
  readonly merchantId: string;
  readonly keyId: string;
}

/**
 * Who is behind this call: a merchant and their key, nobody on a route that
 * takes no key, or a refusal. The switch is exhaustive so a new auth mode
 * cannot silently default to open.
 *
 * A presented key is hashed and looked up by its digest, so nothing secret is
 * compared; never compare a key against a secret with `===`, whose time would
 * leak how much of it was right. A key never issued and a disabled key come
 * back the same way, or the door would confirm which guesses were once real
 * keys. Do not cache the lookup without deciding how long a revoked key may go
 * on working.
 */
async function callerBehind(
  auth: AuthMode,
  request: Request,
  gateway: Gateway,
): Promise<Caller | null | typeof REFUSED | typeof OTHER_ENVIRONMENT_PREFIX> {
  switch (auth) {
    case "merchant_key": {
      const presented = merchantKeyFrom(request.header(MERCHANT_KEY_HEADER) ?? undefined);
      if (presented === null) {
        return REFUSED;
      }

      // Only this environment's prefix reaches the lookup: a key without it was
      // not issued here, even if an old row would still match its digest. A
      // value with the other environment's prefix is told where such keys work,
      // which reveals nothing its holder cannot read; anything else gets the
      // plain refusal.
      const theirs = environmentOfKeyPrefix(presented);
      if (theirs === null) {
        return REFUSED;
      }
      if (theirs !== gateway.environment) {
        return OTHER_ENVIRONMENT_PREFIX;
      }

      const key = await gateway.keyBehind(presented, request.header("user-agent"));
      return key === null ? REFUSED : { merchantId: key.merchantId, keyId: key.id };
    }

    // No key is read: on an open route the payment stands in for
    // authorisation, and on the agent's route the order's identifier does.
    case "none":
    case "order_id":
      return null;

    case "undecided":
      throw new Error("a route whose door nobody has chosen reached the door");

    default: {
      const unanswered: never = auth;
      throw new Error(`this gateway builds no door for ${String(unanswered)}`);
    }
  }
}

/**
 * Whether a thrown value is a refusal of the caller (a 4xx status set by the
 * body parser or the router) rather than a failure of ours.
 */
function blamesTheCaller(thrown: unknown): boolean {
  if (typeof thrown !== "object" || thrown === null || !("status" in thrown)) {
    return false;
  }
  const { status } = thrown as { status: unknown };
  return typeof status === "number" && status >= 400 && status < 500;
}

/** The `type` the body parser puts on most of its refusals, if any. */
function refusalType(thrown: unknown): string | null {
  if (typeof thrown !== "object" || thrown === null || !("type" in thrown)) {
    return null;
  }
  const { type } = thrown as { type: unknown };
  return typeof type === "string" ? type : null;
}

/**
 * Whether the caller asked for the body to be decompressed. An absent or empty
 * header means identity, as the parser reads it.
 */
function declaresCompression(request: Request): boolean {
  const declared = request.headers["content-encoding"];
  if (typeof declared !== "string") {
    return false;
  }
  const named = declared.toLowerCase().trim();
  return named !== "" && named !== "identity";
}

interface Problem {
  readonly path: readonly string[];
  readonly code: string;
  readonly message: string;
}

type Held = { ok: true; value: unknown } | { ok: false; problems: readonly Problem[] };

export function hold(schema: ZodType, value: unknown): Held {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => ({
      path: issue.path.map((step) => String(step)),
      code: issue.code,
      message: issue.message,
    })),
  };
}

/**
 * Whether making the same call again could get past each refusal. A full
 * record, so a new code stops the build until it is answered here.
 *
 * True only where repeating this very call is the way through, not where a
 * retry might coincide with somebody else fixing something: a wrong false
 * costs one call, a wrong true costs an endless loop. `payment_not_verified`
 * and `payment_not_taken` normally carry the payment layer's own answer
 * instead (see {@link refusal}).
 */
const RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  gateway_failed: true,

  // Not yet priced, and the same call returns the document once it is.
  order_not_priced_yet: true,

  body_too_large: false,
  body_undecodable: false,
  charset_unsupported: false,
  encoding_unsupported: false,
  malformed_body: false,
  malformed_query: false,
  params_do_not_fit: false,
  ship_to_changed: false,
  ship_to_does_not_fit: false,
  call_refused: false,

  not_authorised: false,

  no_such_route: false,
  no_such_item: false,
  no_such_order: false,
  merchant_departed: false,

  // The merchant may put it back, but that is not the retry working.
  not_selling: false,

  order_closed_before_it_was_priced: false,
  payment_already_spent: false,
  not_this_purchase: false,

  // The floor; the answer carries what the payment layer said.
  payment_not_verified: false,
  payment_not_taken: false,
};

/**
 * Every refusal this gateway sends, in the contract's envelope with one of its
 * error codes and our own sentence.
 *
 * `detail` goes inside the envelope and is spread first, so a detail field
 * named `message` or `code` can never replace the refusal's own. `retryable`
 * is taken out by name: only the payment layer knows whether its own answer
 * might change on a second look; everything else takes {@link RETRYABLE}.
 */
export function refusal(
  code: ErrorCode,
  message: string,
  detail?: Readonly<Record<string, unknown>> & { readonly retryable?: boolean },
): ErrorEnvelope {
  const { retryable, ...rest } = detail ?? {};
  return {
    error: { ...rest, code, message, retryable: retryable ?? RETRYABLE[code] },
  };
}
