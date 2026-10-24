/**
 * Asks the public CDP validation endpoint whether it would take a gateway's
 * paid resources, which no offline check can answer; the endpoint must reach
 * the gateway, so this runs against a deployment rather than in `pnpm test`.
 * The validator probes only with POST, the method the declaration names, so
 * each resource is also sent the plain unpaid GET an agent reading it by hand
 * sends: a payment made with a GET is read by nothing, and the agent's money
 * is left reserved. A verdict nobody gave is never reported as a pass.
 *
 * Nothing is spent: the endpoint is public, takes no key and moves no money.
 */

import { API_ROUTES, expandPath } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { z } from "zod";
import { PAYMENT_REQUIRED_HEADER } from "./http/x402.js";

/**
 * Only the identifiers are read: every other field named here would be one
 * more way for an older copy of this code to turn away a working gateway.
 */
const CATALOG_IDENTIFIERS = z.object({
  items: z.array(z.object({ id: z.string().min(1) })),
});

type CatalogIdentifiers = z.infer<typeof CATALOG_IDENTIFIERS>;

/** How long one fetch of the check waits for its whole answer. */
const FETCH_WAIT_MS = 10_000;

/** How long the check the operator runs from Health may take in all. */
const LISTING_CHECK_MS = 20_000;

/** Public: it takes no key and costs nothing. */
const VALIDATE_ENDPOINT = "https://api.cdp.coinbase.com/platform/v2/x402/validate";

/** The method a purchase is made with, and so the method a challenge declares. */
const PURCHASE_METHOD = "POST";

/**
 * The validator holds a probe to the method the declaration names, which is
 * always POST, and asked with GET it only says it was probed the wrong way. The
 * GET is therefore checked at the door directly.
 */
const PROBED_METHODS = [PURCHASE_METHOD] as const;

export type ValidateAnswer =
  | { readonly kind: "answered"; readonly status: number; readonly body: unknown }
  | { readonly kind: "unreachable"; readonly why: string };

/** The answer to a plain unpaid GET of the resource. */
export type DoorAnswer =
  /** `challenge` is the header as it came, or null when none was set. */
  | { readonly kind: "answered"; readonly status: number; readonly challenge: string | null }
  | { readonly kind: "unreachable"; readonly why: string };

export interface Reach {
  /** Throws with the reason when the catalog cannot be read. */
  readonly catalog: (baseUrl: string) => Promise<CatalogIdentifiers>;
  readonly validate: (resource: string, method: string) => Promise<ValidateAnswer>;
  /** Fetches the resource the way an agent's own first fetch does. */
  readonly door: (resource: string) => Promise<DoorAnswer>;
}

/** What one probe concluded. */
export type Verdict =
  | { readonly said: "valid" }
  /** `why` is set only when this check is the one refusing. */
  | { readonly said: "invalid"; readonly why?: string }
  /** Nobody gave a verdict, which is not a failure of the resource. */
  | { readonly said: "no answer"; readonly why: string };

/** One product checked: its address, the knock at the door, and the validator's answers. */
type ResourceCheck =
  | {
      readonly itemId: string;
      readonly resource: string;
      /** At the door this check is the judge, so a refusal always says why. */
      readonly door: Verdict;
      readonly validator: readonly {
        readonly method: string;
        readonly verdict: Verdict;
        /** What came back, whole, for a person to read. */
        readonly answer: ValidateAnswer;
      }[];
    }
  /** The catalog named an identifier no address can be made of. */
  | { readonly itemId: string; readonly unbuildable: string };

export type ListingCheck =
  | { readonly kind: "catalog_unreadable"; readonly base: string; readonly why: string }
  /** Zero resources checked is not zero failures: nothing is on sale to check. */
  | { readonly kind: "nothing_on_sale"; readonly base: string }
  | {
      readonly kind: "checked";
      readonly base: string;
      readonly resources: readonly ResourceCheck[];
      /** How many probes were made: the knock and each method, for every product with an address. */
      readonly probes: number;
      /** The probes refused, as "GET <resource>: why" or "POST <resource>". */
      readonly refused: readonly string[];
      /** The probes nobody gave a verdict on, each with why. */
      readonly unanswered: readonly string[];
      /** The products the check's time ran out before, which nothing is said about. */
      readonly unchecked: readonly string[];
      /** Whether every probe of every product was accepted. */
      readonly passed: boolean;
    };

const OUT_OF_TIME = Symbol("out of time");

/** What `work` came to, or `OUT_OF_TIME` where the moment `until` came first; with no moment, it waits. */
async function before<T>(
  until: number | null,
  work: () => Promise<T>,
): Promise<T | typeof OUT_OF_TIME> {
  if (until === null) return await work();
  const left = until - Date.now();
  if (left <= 0) return OUT_OF_TIME;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<typeof OUT_OF_TIME>((resolve) => {
        timer = setTimeout(() => resolve(OUT_OF_TIME), left);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks the products `named`, or with none named every card in the catalog
 * at `base`, which carries no trailing slash. Given `withinMs`, it stops when
 * that time is up and names the products it did not reach; a product whose
 * probes the time cut is counted among them, not judged on half its probes.
 */
export async function listingCheckOf(
  base: string,
  named: readonly string[],
  reach: Reach,
  withinMs: number | null = null,
): Promise<ListingCheck> {
  const until = withinMs === null ? null : Date.now() + withinMs;
  let items: readonly string[];
  if (named.length > 0) {
    items = named;
  } else {
    try {
      const catalog = await before(until, () => reach.catalog(base));
      if (catalog === OUT_OF_TIME) {
        return {
          kind: "catalog_unreadable",
          base,
          why: `no answer within ${secondsOf(withinMs ?? 0)} seconds`,
        };
      }
      items = catalog.items.map((item) => item.id);
    } catch (thrown) {
      return { kind: "catalog_unreadable", base, why: messageOf(thrown) };
    }
  }
  if (items.length === 0) return { kind: "nothing_on_sale", base };

  const resources: ResourceCheck[] = [];
  const refused: string[] = [];
  const unanswered: string[] = [];
  const unchecked: string[] = [];
  for (const itemId of items) {
    if (unchecked.length > 0) {
      unchecked.push(itemId);
      continue;
    }
    // An identifier from the catalog may be something no address can be made
    // of, such as a dot; it is reported apart and the rest is still checked.
    let resource: string;
    try {
      resource = `${base}${expandPath(API_ROUTES.purchase_item.path, { item_id: itemId })}`;
    } catch (thrown) {
      resources.push({ itemId, unbuildable: messageOf(thrown) });
      continue;
    }

    const probed = await before(until, async () => {
      const itemRefused: string[] = [];
      const itemUnanswered: string[] = [];
      // Our own knock first: it is the cheaper question, and whatever the catalog
      // says, an agent that finds this resource fetches it like this.
      const door = doorVerdictOf(await reach.door(resource));
      if (door.said === "invalid") itemRefused.push(`GET ${resource}: ${door.why}`);
      if (door.said === "no answer") itemUnanswered.push(`GET ${resource}: ${door.why}`);

      const validator = [];
      for (const method of PROBED_METHODS) {
        const answer = await reach.validate(resource, method);
        const verdict = verdictOf(answer);
        if (verdict.said === "invalid") itemRefused.push(`${method} ${resource}`);
        if (verdict.said === "no answer") {
          itemUnanswered.push(`${method} ${resource}: ${verdict.why}`);
        }
        validator.push({ method, verdict, answer });
      }
      return { door, validator, itemRefused, itemUnanswered };
    });
    if (probed === OUT_OF_TIME) {
      unchecked.push(itemId);
      continue;
    }
    refused.push(...probed.itemRefused);
    unanswered.push(...probed.itemUnanswered);
    resources.push({ itemId, resource, door: probed.door, validator: probed.validator });
  }

  const built = resources.filter((each) => "resource" in each).length;
  return {
    kind: "checked",
    base,
    resources,
    probes: built * (PROBED_METHODS.length + 1),
    refused,
    unanswered,
    unchecked,
    passed:
      refused.length === 0 &&
      unanswered.length === 0 &&
      unchecked.length === 0 &&
      built === items.length,
  };
}

const secondsOf = (ms: number): string => String(ms / 1_000);

/** Why a fetch came back with nothing, in words: its own wait running out, or what fetch threw. */
const whyUnreached = (thrown: unknown, waitMs: number): string =>
  thrown instanceof Error && thrown.name === "TimeoutError"
    ? `no answer within ${secondsOf(waitMs)} seconds`
    : messageOf(thrown);

/**
 * A wallet's address, which a validator's answer may carry for the address a
 * resource asks to be paid at, and which the operator's screen does not show.
 */
const WALLET = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/** Every string inside an answer with its wallet addresses replaced by the words "a wallet". */
function withWalletsHidden(value: unknown): unknown {
  if (typeof value === "string") return value.replace(WALLET, "a wallet");
  if (Array.isArray(value)) return value.map(withWalletsHidden);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, held]) => [key, withWalletsHidden(held)]),
    );
  }
  return value;
}

/**
 * The listing check the operator runs from Health against the channel's own
 * public address: what was checked, what came back and when, with every
 * wallet address in what the validator and the gateway's door said replaced
 * by the words "a wallet". The operator's request waits on it, so it stops
 * after `withinMs` and names what it did not check.
 */
export async function checkListingNow(
  base: string,
  reach: Reach,
  clock: () => number = Date.now,
  withinMs: number = LISTING_CHECK_MS,
): Promise<ListingCheck & { readonly checkedAt: number }> {
  const checked = await listingCheckOf(base.replace(/\/+$/, ""), [], reach, withinMs);
  return { ...(withWalletsHidden(checked) as ListingCheck), checkedAt: clock() };
}

/**
 * Only an answer that says `valid: true` is a pass. One this cannot read is no
 * verdict, neither a pass nor a failure of the resource. The rest of the body
 * is not modelled; it is kept whole for a person to read.
 */
function verdictOf(answer: ValidateAnswer): Verdict {
  if (answer.kind === "unreachable") {
    return { said: "no answer", why: answer.why };
  }
  if (answer.status !== 200) {
    return { said: "no answer", why: `the endpoint answered ${answer.status}` };
  }

  const body = answer.body;
  const valid =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).valid : undefined;

  if (valid === true) {
    return { said: "valid" };
  }
  if (valid === false) {
    return { said: "invalid" };
  }
  return { said: "no answer", why: "the answer carried no verdict this command could read" };
}

/**
 * Stricter than at the validator: this door is ours and its promise is known,
 * so any status but 402, a missing or undecodable challenge, or one naming any
 * method but the purchase's is a refusal. Only an unreachable door stays no
 * verdict, since what it would have said is still unknown.
 */
function doorVerdictOf(answer: DoorAnswer): Verdict & { readonly why?: string } {
  if (answer.kind === "unreachable") {
    return { said: "no answer", why: answer.why };
  }
  if (answer.status !== 402) {
    return {
      said: "invalid",
      why: `it answered ${answer.status}, and an unpaid GET is answered with a price`,
    };
  }
  if (answer.challenge === null) {
    return {
      said: "invalid",
      why: `it answered 402 and set no ${PAYMENT_REQUIRED_HEADER} header, and a price travels in that header`,
    };
  }

  let declared: unknown;
  try {
    const challenge = decodePaymentRequiredHeader(answer.challenge);
    declared = fieldIn(fieldIn(fieldIn(challenge.extensions?.bazaar, "info"), "input"), "method");
  } catch (thrown) {
    return {
      said: "invalid",
      why: `its ${PAYMENT_REQUIRED_HEADER} header would not decode: ${messageOf(thrown)}`,
    };
  }

  if (declared !== PURCHASE_METHOD) {
    return {
      said: "invalid",
      why:
        typeof declared === "string"
          ? `its challenge names ${declared} as the purchase, and a purchase is a ${PURCHASE_METHOD}`
          : "its challenge names no method for the purchase at all",
    };
  }
  return { said: "valid" };
}

function fieldIn(held: unknown, key: string): unknown {
  return typeof held === "object" && held !== null
    ? (held as Record<string, unknown>)[key]
    : undefined;
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * A probe that cannot reach its endpoint, or gets no whole answer within
 * `waitMs`, is turned into an answer rather than thrown, so it is one line in
 * the report instead of the end of the run.
 */
export const overTheNetwork = (waitMs: number = FETCH_WAIT_MS): Reach => ({
  catalog: async (baseUrl) => {
    const at = `${baseUrl}${API_ROUTES.list_catalog.path}`;
    try {
      const answered = await fetch(at, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(waitMs),
      });
      if (!answered.ok) {
        throw new Error(`${at} answered ${answered.status}`);
      }
      // Parsed rather than cast, so JSON that is not a catalog (a proxy, a login
      // page) is refused here instead of failing further down. Only the
      // identifiers are held, because this runs from a local checkout against a
      // deployment that may be newer and carry fields this copy does not know.
      return CATALOG_IDENTIFIERS.parse(await answered.json());
    } catch (thrown) {
      if (thrown instanceof Error && thrown.name === "TimeoutError") {
        throw new Error(`${at} gave ${whyUnreached(thrown, waitMs)}`);
      }
      throw thrown;
    }
  },
  door: async (resource) => {
    try {
      // No payment header, no body, no special accept: this is the fetch an
      // agent makes before it has decided to buy.
      const answered = await fetch(resource, {
        method: "GET",
        signal: AbortSignal.timeout(waitMs),
      });
      // Read and dropped: a body left unread holds its connection open.
      await answered.text();
      return {
        kind: "answered",
        status: answered.status,
        challenge: answered.headers.get(PAYMENT_REQUIRED_HEADER),
      };
    } catch (thrown) {
      return { kind: "unreachable", why: whyUnreached(thrown, waitMs) };
    }
  },
  validate: async (resource, method) => {
    try {
      const answered = await fetch(VALIDATE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource, method }),
        signal: AbortSignal.timeout(waitMs),
      });
      const text = await answered.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // Kept as text: an endpoint answering HTML happens, and that reads as no
        // verdict rather than a crash.
        body = text;
      }
      return { kind: "answered", status: answered.status, body };
    } catch (thrown) {
      return { kind: "unreachable", why: whyUnreached(thrown, waitMs) };
    }
  },
});
