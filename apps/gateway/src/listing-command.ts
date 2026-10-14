/**
 * Asks the public CDP validation endpoint whether it would take this gateway's
 * paid resources, which no offline check can answer; the endpoint must reach
 * the gateway, so this runs against a deployment rather than in `pnpm test`.
 * The validator probes only with POST, the method the declaration names, so
 * each resource is also sent the plain unpaid GET an agent reading it by hand
 * sends: a payment made with a GET is read by nothing, and the agent's money
 * is left reserved. A verdict the catalog did not give is never reported as a
 * pass, and it exits non-zero.
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

type Verdict =
  | { readonly said: "valid" }
  /** `why` is set only when this command is the one refusing. */
  | { readonly said: "invalid"; readonly why?: string }
  /** Nobody gave a verdict, which is not a failure of the resource. */
  | { readonly said: "no answer"; readonly why: string };

/**
 * At the door this command is the judge, so a refusal always says why: there
 * is nobody else's answer to print underneath.
 */
type DoorVerdict =
  | { readonly said: "valid" }
  | { readonly said: "invalid"; readonly why: string }
  | { readonly said: "no answer"; readonly why: string };

const USAGE = [
  "Usage: pnpm smoke:listing <base-url> [item-id ...]",
  "",
  "Asks the public CDP validation endpoint whether it would take this",
  "gateway's paid resources. With no item named it asks about every card in",
  "the public catalog.",
  "",
  "Each resource is also fetched from here, with the plain unpaid GET an agent",
  "reading it by hand sends, and held to what the door promises: a price, and a",
  "challenge naming the purchase as a POST.",
  "",
  "The gateway has to be reachable from the internet: the endpoint fetches",
  "the resource itself. A laptop is not reachable, and this command says so",
  "rather than reporting a pass it did not see.",
  "",
  "Nothing is spent. The endpoint is public, takes no key and moves no money.",
];

export async function runListingCheck(
  argv: readonly string[],
  reach: Reach,
  say: (line: string) => void,
): Promise<number> {
  const [baseUrl, ...named] = argv;

  if (baseUrl === undefined || baseUrl.trim() === "") {
    for (const line of USAGE) {
      say(line);
    }
    return 2;
  }

  const base = baseUrl.replace(/\/+$/, "");

  // A path is joined onto this, so a query or fragment lands in the middle of
  // every resource address, and the endpoint's refusal would read as though
  // the product were at fault.
  for (const [mark, what] of [
    ["?", "query"],
    ["#", "fragment"],
  ] as const) {
    if (base.includes(mark)) {
      say(`${baseUrl} carries a ${what}, and a path is joined onto this address.`);
      say("Give the address the gateway answers at and nothing after it.");
      return 2;
    }
  }

  if (!base.toLowerCase().startsWith("https://")) {
    // The endpoint answers 400 to an http address. This only warns: the
    // endpoint's rules are its own, and a run that asks and reports what came
    // back is worth more than one that decided in advance.
    say(`${base} is not an https address, and the endpoint only takes those.`);
    say("Expect no verdict. A listing needs a public https gateway.");
  }

  let items: readonly string[];

  if (named.length > 0) {
    items = named;
  } else {
    let catalog: CatalogIdentifiers;
    try {
      catalog = await reach.catalog(base);
    } catch (thrown) {
      say(`The catalog at ${base} could not be read: ${messageOf(thrown)}`);
      say("Nothing was checked.");
      return 1;
    }
    items = catalog.items.map((item) => item.id);
  }

  if (items.length === 0) {
    // Zero resources checked is not zero failures. The catalog is empty exactly
    // when every card is paused or none was published, which is when somebody
    // most needs to be told.
    say(`There is nothing on sale at ${base}, so there is nothing to check.`);
    return 1;
  }

  const failures: string[] = [];
  const silences: string[] = [];
  /** Products the catalog named that no address could be built for. */
  const unbuildable: string[] = [];

  for (const itemId of items) {
    // An identifier from the catalog may be something no address can be made
    // of, such as a dot; it is reported on one line and the rest of the catalog
    // is still checked.
    let resource: string;
    try {
      resource = `${base}${expandPath(API_ROUTES.purchase_item.path, { item_id: itemId })}`;
    } catch (thrown) {
      say("");
      say(`${JSON.stringify(itemId)}: no address could be built for it`);
      say(`  ${messageOf(thrown)}`);
      unbuildable.push(itemId);
      continue;
    }

    // Our own knock first: it is the cheaper question, and whatever the catalog
    // says, an agent that finds this resource fetches it like this.
    const knocked = await reach.door(resource);
    const atTheDoor = doorVerdictOf(knocked);
    say("");
    say(`GET ${resource}`);
    say(`  ${wordFor(atTheDoor)}`);

    if (atTheDoor.said === "invalid") {
      failures.push(`GET ${resource}: ${atTheDoor.why}`);
    }
    if (atTheDoor.said === "no answer") {
      silences.push(`GET ${resource}: ${atTheDoor.why}`);
    }

    for (const method of PROBED_METHODS) {
      const answer = await reach.validate(resource, method);
      const verdict = verdictOf(answer);
      say("");
      say(`${method} ${resource}`);
      say(`  ${wordFor(verdict)}`);
      say(indented(answer));

      if (verdict.said === "invalid") {
        failures.push(`${method} ${resource}`);
      }
      if (verdict.said === "no answer") {
        silences.push(`${method} ${resource}: ${verdict.why}`);
      }
    }
  }

  say("");
  // One probe per method the validator is asked with, plus the knock at the
  // door, counted together because they check the same resource.
  const probes = (items.length - unbuildable.length) * (PROBED_METHODS.length + 1);

  // "It said no" and "no answer came" stay apart in the summary because only
  // the first is about the resource.
  if (silences.length > 0) {
    say(`${silences.length} of ${probes} probes got no verdict, so nothing is proven about them:`);
    for (const silence of silences) {
      say(`  ${silence}`);
    }
  }
  if (failures.length > 0) {
    say(`${failures.length} of ${probes} probes were refused:`);
    for (const failure of failures) {
      say(`  ${failure}`);
    }
  }
  if (unbuildable.length > 0) {
    say(`${unbuildable.length} of ${items.length} products had no address to check:`);
    for (const itemId of unbuildable) {
      say(`  ${JSON.stringify(itemId)}`);
    }
  }
  if (silences.length === 0 && failures.length === 0 && unbuildable.length === 0) {
    // Counts the products it was given rather than calling the whole catalog
    // good: a missing paging field is not a promise that there is nothing more.
    say(
      `All ${probes} probes over the ${items.length} products this catalog listed were accepted.`,
    );
    return 0;
  }
  return 1;
}

/**
 * Only an answer that says `valid: true` is a pass. One this cannot read is no
 * verdict, neither a pass nor a failure of the resource. The rest of the body
 * is not modelled; it is printed whole for a person to read.
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
function doorVerdictOf(answer: DoorAnswer): DoorVerdict {
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

function wordFor(verdict: Verdict): string {
  switch (verdict.said) {
    case "valid":
      return "accepted";
    case "invalid":
      return verdict.why === undefined ? "refused" : `refused — ${verdict.why}`;
    case "no answer":
      return `no verdict — ${verdict.why}`;
  }
}

function indented(answer: ValidateAnswer): string {
  const text =
    answer.kind === "unreachable" ? answer.why : (JSON.stringify(answer.body, null, 2) ?? "null");
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * A probe that cannot reach its endpoint is turned into an answer rather than
 * thrown, so it is one line in the report instead of the end of the run.
 */
export const overTheNetwork = (): Reach => ({
  catalog: async (baseUrl) => {
    const at = `${baseUrl}${API_ROUTES.list_catalog.path}`;
    const answered = await fetch(at, { headers: { accept: "application/json" } });
    if (!answered.ok) {
      throw new Error(`${at} answered ${answered.status}`);
    }
    // Parsed rather than cast, so JSON that is not a catalog (a proxy, a login
    // page) is refused here instead of failing further down. Only the
    // identifiers are held, because this runs from a local checkout against a
    // deployment that may be newer and carry fields this copy does not know.
    return CATALOG_IDENTIFIERS.parse(await answered.json());
  },
  door: async (resource) => {
    try {
      // No payment header, no body, no special accept: this is the fetch an
      // agent makes before it has decided to buy.
      const answered = await fetch(resource, { method: "GET" });
      // Read and dropped: a body left unread holds its connection open.
      await answered.text();
      return {
        kind: "answered",
        status: answered.status,
        challenge: answered.headers.get(PAYMENT_REQUIRED_HEADER),
      };
    } catch (thrown) {
      return { kind: "unreachable", why: messageOf(thrown) };
    }
  },
  validate: async (resource, method) => {
    try {
      const answered = await fetch(VALIDATE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource, method }),
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
      return { kind: "unreachable", why: messageOf(thrown) };
    }
  },
});
