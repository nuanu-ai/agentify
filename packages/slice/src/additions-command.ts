/**
 * A loopback proxy that answers as a newer gateway would, without moving the
 * contract version: it adds to chosen answers on their way back to the caller
 * the kinds of thing a later gateway may add, and leaves every other byte as
 * the upstream sent it.
 *
 * Each addition is named by what it is, not by where it goes, and the places
 * it reaches are fixed here from the contract: a field where a reader is to
 * ignore what it does not know, a new word where a reader is to read
 * `unknown`, an event of a new kind beside the envelopes of a poll, and,
 * separately, a field in an order's core or a new shape for its address,
 * which a reader is to refuse. An addition can be narrowed to a path pattern,
 * and a pattern that could reach the purchase or the catalog is refused: their
 * answers carry the payment requirements and the settlement, and nothing here
 * rewrites them.
 *
 * Insertion is textual, at offsets read from the upstream's own bytes, so an
 * answer that is rewritten differs from the upstream's only where the log
 * says. As in the cut proxy, the log never prints a header, a body or a query
 * string.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { API_ROUTES, type RouteDefinition, type RouteName } from "@nuanu-ai/agentify-contracts";
import {
  type Answer,
  codeOf,
  DECODERS,
  endToEnd,
  forward,
  listen,
  passThrough,
} from "./cut-command.js";

// ---------------------------------------------------------------------------
// Reading an answer with the offsets of its parts
// ---------------------------------------------------------------------------

interface Span {
  readonly start: number;
  readonly end: number;
}

type Node =
  | (Span & { readonly kind: "object"; readonly members: readonly Member[] })
  | (Span & { readonly kind: "array"; readonly items: readonly Node[] })
  | (Span & { readonly kind: "string"; readonly value: string })
  | (Span & { readonly kind: "scalar"; readonly raw: string });

interface Member {
  readonly key: string;
  readonly value: Node;
}

const SCALAR = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/**
 * The document with the offset of every value in `text`, or the reason it
 * cannot be read: it is not one JSON document, or it nests deeper than the walk
 * can go. `JSON.parse` decides validity; this walk only
 * records where each part lies.
 */
const scan = (text: string): Node | string => {
  try {
    JSON.parse(text);
  } catch {
    return "the body is not one JSON document";
  }
  let at = 0;
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text.charAt(at))) at += 1;
  };
  const string = (): Node & { kind: "string" } => {
    const start = at;
    at += 1;
    while (text.charAt(at) !== '"') at += text.charAt(at) === "\\" ? 2 : 1;
    at += 1;
    return { kind: "string", start, end: at, value: JSON.parse(text.slice(start, at)) };
  };
  const value = (): Node => {
    space();
    const start = at;
    const opening = text.charAt(at);
    if (opening === "{") {
      at += 1;
      const members: Member[] = [];
      space();
      while (text.charAt(at) !== "}") {
        space();
        const key = string().value;
        space();
        at += 1; // the colon
        members.push({ key, value: value() });
        space();
        if (text.charAt(at) === ",") at += 1;
      }
      at += 1;
      return { kind: "object", start, end: at, members };
    }
    if (opening === "[") {
      at += 1;
      const items: Node[] = [];
      space();
      while (text.charAt(at) !== "]") {
        items.push(value());
        space();
        if (text.charAt(at) === ",") at += 1;
      }
      at += 1;
      return { kind: "array", start, end: at, items };
    }
    if (opening === '"') return string();
    SCALAR.lastIndex = at;
    const raw = SCALAR.exec(text)?.[0] ?? "";
    at += raw.length;
    return { kind: "scalar", start, end: at, raw };
  };
  try {
    return value();
  } catch {
    // Nesting deep enough to exhaust the stack: JSON.parse takes it, this
    // walk does not.
    return "the body nests deeper than the proxy can walk";
  }
};

/** The member a reader of this object would take: the last one of that name, as `JSON.parse` does. */
const memberOf = (node: Node | undefined, key: string): Node | undefined =>
  node?.kind === "object"
    ? node.members.findLast((member) => member.key === key)?.value
    : undefined;

const wordOf = (node: Node | undefined, key: string): string | undefined => {
  const found = memberOf(node, key);
  return found?.kind === "string" ? found.value : undefined;
};

const itemsOf = (node: Node | undefined, key: string): readonly Node[] => {
  const found = memberOf(node, key);
  return found?.kind === "array" ? found.items : [];
};

/** A refusal is `{ "error": { ... } }` with nothing beside it; its inside is where a field may go. */
const refusalIn = (document: Node): Node | undefined =>
  document.kind === "object" &&
  document.members.length === 1 &&
  document.members[0]?.key === "error" &&
  document.members[0].value.kind === "object"
    ? document.members[0].value
    : undefined;

// ---------------------------------------------------------------------------
// The additions
// ---------------------------------------------------------------------------

/** One change to the upstream's text, and what the log calls the place it made it. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly where: string;
}

const NOTE_FIELD = '"instrument_note":"added by the additions proxy"';
const DELIVERY_FIELD = '"quantity":3';
const NEW_STATUS = "added_status";
const NEW_EVENT_KIND = "order.added_kind";
const NEW_REASON = "added_reason";
const NEW_RESULT = "added_result";
const NEW_PURPOSE = "added_purpose";
const NEW_PICKUP_POINT = "added_pickup_point";

/** Adds a member just before the object's closing brace. */
const fieldIn = (object: Node, member: string, where: string): Edit => {
  const at = object.end - 1;
  const comma = object.kind === "object" && object.members.length > 0 ? "," : "";
  return { start: at, end: at, text: `${comma}${member}`, where };
};

const wordIn = (node: Node | undefined, word: string, where: string): Edit[] =>
  node?.kind === "string"
    ? [{ start: node.start, end: node.end, text: JSON.stringify(word), where }]
    : [];

const envelopesOf = (document: Node, kind: string): readonly Node[] =>
  itemsOf(document, "envelopes").filter((envelope) => wordOf(envelope, "kind") === kind);

/** The orders an answer carries as a merchant reads them: off the stream, read one by one, or listed. */
const ordersIn = (document: Node, route: RouteName): readonly Node[] => {
  if (refusalIn(document) !== undefined) return [];
  switch (route) {
    case "poll_worker":
      return envelopesOf(document, "order").flatMap((envelope) => {
        const payload = memberOf(envelope, "payload");
        return payload === undefined ? [] : [payload];
      });
    case "get_order":
    case "get_order_status":
      return [document];
    case "list_orders":
      return itemsOf(document, "orders");
    default:
      return [];
  }
};

// The agent's status document names its order in `order_id`; a merchant's order in `id`.
const orderLabel = (order: Node): string =>
  `order ${wordOf(order, "id") ?? wordOf(order, "order_id") ?? "without an id"}`;

const LOCALITY = ["country", "state", "city", "postal_code"] as const;

interface Addition {
  /** Whether a reader is to ignore it (true) or to refuse the answer that carries it (false). */
  readonly informs: boolean;
  /** What the start line and a refusal call the thing added. */
  readonly what: string;
  readonly routes: readonly RouteName[];
  readonly edits: (document: Node, route: RouteName, text: string) => Edit[];
}

const MERCHANT_ROUTES = (Object.keys(API_ROUTES) as RouteName[]).filter((name) =>
  API_ROUTES[name].path.startsWith("/v0/"),
);

const ADDITIONS = {
  field: {
    informs: true,
    what: `a field, ${NOTE_FIELD}, at the top of the answer (not of an order read, which is closed), inside "error" of a refusal, and in each envelope and each event of a poll`,
    routes: [...MERCHANT_ROUTES, "get_order_status"],
    edits: (document, route) => {
      if (document.kind !== "object") return [];
      const error = refusalIn(document);
      if (error !== undefined) return [fieldIn(error, NOTE_FIELD, "error")];
      const edits = route === "get_order" ? [] : [fieldIn(document, NOTE_FIELD, "top")];
      if (route !== "poll_worker") return edits;
      for (const envelope of itemsOf(document, "envelopes")) {
        if (envelope.kind !== "object") continue;
        edits.push(fieldIn(envelope, NOTE_FIELD, "envelope"));
        const payload = memberOf(envelope, "payload");
        if (wordOf(envelope, "kind") === "order_event" && payload?.kind === "object") {
          edits.push(fieldIn(payload, NOTE_FIELD, "event"));
        }
      }
      return edits;
    },
  },
  "status-word": {
    informs: true,
    what: `the order status word "${NEW_STATUS}" in place of each order's status`,
    routes: ["get_order", "list_orders", "get_order_status"],
    edits: (document, route) =>
      ordersIn(document, route).flatMap((order) =>
        wordIn(memberOf(order, "status"), NEW_STATUS, orderLabel(order)),
      ),
  },
  "event-kind": {
    informs: true,
    what: `an event of the kind "${NEW_EVENT_KIND}" in a new envelope after each order and each order event of a poll, about the same order`,
    routes: ["poll_worker"],
    edits: (document, _route, text) =>
      itemsOf(document, "envelopes").flatMap((envelope) => {
        const kind = wordOf(envelope, "kind");
        const payload = memberOf(envelope, "payload");
        const order = memberOf(payload, kind === "order" ? "id" : "order_id");
        const id = wordOf(envelope, "id");
        const sentAt = memberOf(envelope, "sent_at");
        if (
          (kind !== "order" && kind !== "order_event") ||
          order?.kind !== "string" ||
          id === undefined ||
          sentAt === undefined
        ) {
          return [];
        }
        const raw = (node: Node) => text.slice(node.start, node.end);
        const added = `{"kind":"order_event","id":${JSON.stringify(`${id}.added`)},"sent_at":${raw(sentAt)},"payload":{"type":${JSON.stringify(NEW_EVENT_KIND)},"order_id":${raw(order)},"at":${raw(sentAt)}}}`;
        return [
          {
            start: envelope.end,
            end: envelope.end,
            text: `,${added}`,
            where: `beside the ${kind === "order" ? "order" : "event"} of order ${order.value}`,
          },
        ];
      }),
  },
  "event-reason": {
    informs: true,
    what: `the reason "${NEW_REASON}" in place of the reason of each event in a poll that carries one, which order.unfulfilled does`,
    routes: ["poll_worker"],
    edits: (document) =>
      envelopesOf(document, "order_event").flatMap((envelope) => {
        const event = memberOf(envelope, "payload");
        return wordIn(
          memberOf(event, "reason"),
          NEW_REASON,
          `event of order ${wordOf(event, "order_id") ?? "without an id"}`,
        );
      }),
  },
  "result-word": {
    informs: true,
    what: `the result word "${NEW_RESULT}" in place of the result of a successful answer, delivery or refusal`,
    routes: ["answer_order", "deliver_order", "refuse_order"],
    // A failed call carries `error` and no result, so only a success is reached.
    edits: (document) => wordIn(memberOf(document, "result"), NEW_RESULT, "result"),
  },
  "quote-purpose": {
    informs: true,
    what: `the purpose "${NEW_PURPOSE}" in place of each price question's purpose in a poll`,
    routes: ["poll_worker"],
    edits: (document) =>
      envelopesOf(document, "quote_request").flatMap((envelope) => {
        const question = memberOf(envelope, "payload");
        return wordIn(
          memberOf(question, "purpose"),
          NEW_PURPOSE,
          `price question ${wordOf(question, "price_id") ?? "without an id"}`,
        );
      }),
  },
  "delivery-field": {
    informs: false,
    what: `a field, ${DELIVERY_FIELD}, in each order's core: an order off a poll, an order read and each order listed`,
    routes: ["poll_worker", "get_order", "list_orders"],
    edits: (document, route) =>
      ordersIn(document, route).flatMap((order) =>
        order.kind === "object" ? [fieldIn(order, DELIVERY_FIELD, orderLabel(order))] : [],
      ),
  },
  "address-shape": {
    informs: false,
    what: `a pickup point, {"pickup_point":"${NEW_PICKUP_POINT}"} with the address's country, state, city and postal code, in place of each order's ship_to that names a place (an erased one is left as it is)`,
    routes: ["poll_worker", "get_order", "list_orders"],
    edits: (document, route, text) =>
      ordersIn(document, route).flatMap((order) => {
        const shipTo = memberOf(order, "ship_to");
        if (shipTo?.kind !== "object" || memberOf(shipTo, "city") === undefined) return [];
        const kept = shipTo.members
          .filter((member) => (LOCALITY as readonly string[]).includes(member.key))
          .map(
            (member) =>
              `${JSON.stringify(member.key)}:${text.slice(member.value.start, member.value.end)}`,
          );
        return [
          {
            start: shipTo.start,
            end: shipTo.end,
            text: `{${[`"pickup_point":${JSON.stringify(NEW_PICKUP_POINT)}`, ...kept].join(",")}}`,
            where: orderLabel(order),
          },
        ];
      }),
  },
} as const satisfies Record<string, Addition>;

type AdditionName = keyof typeof ADDITIONS;

const ADDITION_NAMES = Object.keys(ADDITIONS) as AdditionName[];

const isAddition = (name: string): name is AdditionName => Object.hasOwn(ADDITIONS, name);

// ---------------------------------------------------------------------------
// Routes and patterns
// ---------------------------------------------------------------------------

const escaped = (part: string): string => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const routePattern = (path: string): RegExp =>
  new RegExp(
    `^${path
      .split("/")
      .map((segment) => (segment.startsWith(":") ? "[^/]+" : escaped(segment)))
      .join("/")}$`,
  );

const ROUTES = (Object.keys(API_ROUTES) as RouteName[]).map((name) => {
  const route: RouteDefinition = API_ROUTES[name];
  return {
    name,
    methods: [route.method, ...(route.also_answers_on ?? [])] as readonly string[],
    pattern: routePattern(route.path),
  };
});

const routeOf = (method: string, path: string): RouteName | undefined =>
  ROUTES.find((route) => route.methods.includes(method) && route.pattern.test(path))?.name;

/** A path pattern as the cut proxy reads one: `*` stands for any run of characters within one segment. */
const pathPattern = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split("*").map(escaped).join("[^/]*")}$`);

/** Whether a path the pattern matches could be one of the route's. */
const reaches = (pattern: string, route: RouteName): boolean => {
  const asked = pattern.split("/");
  const served = API_ROUTES[route].path.split("/");
  return (
    asked.length === served.length &&
    asked.every((segment, at) => {
      const own = served[at] ?? "";
      return own.startsWith(":") ? segment !== "" : pathPattern(segment).test(own);
    })
  );
};

/** Answers that carry a payment's requirements or its settlement. */
const NEVER_REWRITTEN: readonly RouteName[] = ["purchase_item", "list_catalog"];

const routeName = (route: RouteName): string =>
  `${API_ROUTES[route].method} ${API_ROUTES[route].path}`;

const answersOf = (addition: Addition): string => {
  const everyMerchantRoute = MERCHANT_ROUTES.every((route) => addition.routes.includes(route));
  return [
    ...(everyMerchantRoute ? ["every merchant route under /v0/"] : []),
    ...addition.routes
      .filter((route) => !everyMerchantRoute || !MERCHANT_ROUTES.includes(route))
      .map(routeName),
  ].join(", ");
};

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

interface Rule {
  readonly name: AdditionName;
  /** The path pattern the addition is narrowed to, or null for every answer it can reach. */
  readonly only: string | null;
  readonly matches: (path: string) => boolean;
}

interface Settings {
  readonly upstream: URL;
  readonly port: number;
  readonly rules: readonly Rule[];
}

type Read =
  | { readonly ok: true; readonly settings: Settings }
  | { readonly ok: false; readonly why: string };

type Started =
  | { readonly ok: true; readonly proxy: { readonly port: number; close(): Promise<void> } }
  | { readonly ok: false; readonly why: string };

const DEFAULT_PORT = "8791";

const refused = (why: string): Read => ({ ok: false, why });

const readRule = (value: string): { rule: Rule } | { why: string } => {
  const at = value.indexOf("@");
  const name = at === -1 ? value : value.slice(0, at);
  const only = at === -1 ? null : value.slice(at + 1);
  if (!isAddition(name)) {
    return {
      why: `--add takes one of ${ADDITION_NAMES.join(", ")}, optionally followed by @ and a path pattern, not ${JSON.stringify(value)}.`,
    };
  }
  const addition: Addition = ADDITIONS[name];
  if (only === null) {
    return { rule: { name, only, matches: () => true } };
  }
  if (!only.startsWith("/") || only.includes("?")) {
    return {
      why: `--add ${name}@ takes a path pattern that starts with / and has no query string, such as /v0/orders/*, not ${JSON.stringify(only)}.`,
    };
  }
  const payment = NEVER_REWRITTEN.filter((route) => reaches(only, route));
  if (payment.length > 0) {
    return {
      why: `--add ${name}@${only} could reach ${payment.map(routeName).join(" and ")}, whose answers carry a payment's requirements or its settlement, and this proxy never rewrites them.`,
    };
  }
  if (!addition.routes.some((route) => reaches(only, route))) {
    return {
      why: `--add ${name}@${only} matches none of the answers ${name} is added to: ${answersOf(addition)}.`,
    };
  }
  const pattern = pathPattern(only);
  return { rule: { name, only, matches: (path) => pattern.test(path) } };
};

const readSettings = (argv: readonly string[]): Read => {
  let to: string | undefined;
  let port = DEFAULT_PORT;
  const rules: Rule[] = [];
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at] ?? "";
    const value = argv[at + 1];
    if (flag !== "--to" && flag !== "--port" && flag !== "--add") {
      const shown = flag.startsWith("--") ? `"${flag.replace(/=.*/s, "=…")}"` : "a bare value";
      return refused(
        `Expected --to, --port or --add, each followed by its value after a space, and got ${shown}.`,
      );
    }
    if (value === undefined || value.startsWith("--")) {
      return refused(`${flag} needs a value after it.`);
    }
    if (flag === "--to") {
      if (to !== undefined)
        return refused("--to is given twice; the proxy forwards to one upstream.");
      to = value;
    } else if (flag === "--port") {
      port = value;
    } else {
      const read = readRule(value);
      if ("why" in read) return refused(read.why);
      if (rules.some((rule) => rule.name === read.rule.name)) {
        return refused(`--add ${read.rule.name} is given twice; give each addition once.`);
      }
      rules.push(read.rule);
    }
  }
  if (to === undefined) {
    return refused(
      "--to is required: the gateway's http or https base URL, such as http://localhost:8080.",
    );
  }
  const upstream = URL.canParse(to) ? new URL(to) : null;
  if (upstream !== null && (upstream.username !== "" || upstream.password !== "")) {
    return refused(
      "--to must not carry a user name or password; the caller's own credentials travel in its headers.",
    );
  }
  if (
    upstream === null ||
    (upstream.protocol !== "http:" && upstream.protocol !== "https:") ||
    upstream.search !== "" ||
    upstream.hash !== ""
  ) {
    return refused("--to takes the gateway's http or https base URL with no query or fragment.");
  }
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) {
    return refused(
      `--port takes a port from 0 to 65535 to listen on at 127.0.0.1, not ${JSON.stringify(port)}.`,
    );
  }
  if (rules.length === 0) {
    return refused(`--add is required at least once: one of ${ADDITION_NAMES.join(", ")}.`);
  }
  const informing = rules.filter((rule) => ADDITIONS[rule.name].informs);
  const delivering = rules.filter((rule) => !ADDITIONS[rule.name].informs);
  if (informing.length > 0 && delivering.length > 0) {
    return refused(
      `${delivering.map((rule) => rule.name).join(" and ")} cannot run beside ${informing.map((rule) => rule.name).join(", ")}: an addition to what an order delivers fails the answer that carries it, which would hide whether the additions that only inform were read. Run them in two runs.`,
    );
  }
  return { ok: true, settings: { upstream, port: Number(port), rules } };
};

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

/** Says each place once, with how many times it was reached. */
const tally = (edits: readonly (Edit & { readonly name: AdditionName })[]): string => {
  const byName = new Map<AdditionName, Map<string, number>>();
  for (const edit of edits) {
    const places = byName.get(edit.name) ?? new Map<string, number>();
    places.set(edit.where, (places.get(edit.where) ?? 0) + 1);
    byName.set(edit.name, places);
  }
  return [...byName]
    .map(
      ([name, places]) =>
        `${name} (${[...places].map(([where, times]) => (times === 1 ? where : `${where} ×${times}`)).join("; ")})`,
    )
    .join(", ");
};

const isJson = (answer: Answer): boolean => {
  const type = String(answer.headers["content-type"] ?? "").toLowerCase();
  return /^application\/(?:[\w.+-]+\+)?json\b/.test(type);
};

type Rewrite =
  | { readonly body: Buffer; readonly edits: readonly (Edit & { readonly name: AdditionName })[] }
  | { readonly why: string };

const rewrite = (answer: Answer, route: RouteName, names: readonly AdditionName[]): Rewrite => {
  if (
    answer.status === 402 ||
    answer.headers["payment-required"] !== undefined ||
    answer.headers["payment-response"] !== undefined
  ) {
    return { why: "it carries a payment challenge or settlement, which this proxy never rewrites" };
  }
  if (!isJson(answer)) {
    return { why: "it is not JSON" };
  }
  const coding = String(answer.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  let plain = answer.body;
  if (coding !== "" && coding !== "identity") {
    const decode = DECODERS.get(coding);
    if (decode === undefined) {
      return { why: `the proxy does not decode ${coding}` };
    }
    try {
      plain = decode(answer.body);
    } catch (error) {
      return { why: `the body did not decode as ${coding} (${codeOf(error)})` };
    }
  }
  const text = plain.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(plain)) {
    return { why: "the body is not UTF-8" };
  }
  const document = scan(text);
  if (typeof document === "string") {
    return { why: document };
  }
  const edits = names
    .flatMap((name) =>
      ADDITIONS[name].edits(document, route, text).map((edit) => ({ ...edit, name })),
    )
    .sort((one, other) => one.start - other.start);
  // One pass over the text: a list with tens of thousands of orders is
  // rewritten in the time it takes to copy it, not once per edit.
  const pieces: string[] = [];
  let copied = 0;
  for (const edit of edits) {
    pieces.push(text.slice(copied, edit.start), edit.text);
    copied = edit.end;
  }
  pieces.push(text.slice(copied));
  return { body: Buffer.from(pieces.join(""), "utf8"), edits };
};

/**
 * Sends the rewritten body unencoded. The length is restated, and the coding,
 * the entity tag and any digest are dropped, because they described the
 * upstream's bytes.
 */
const sendRewritten = (response: ServerResponse, answer: Answer, body: Buffer): void => {
  const {
    "content-encoding": _coding,
    etag: _tag,
    "content-md5": _md5,
    digest: _digest,
    "content-digest": _contentDigest,
    "repr-digest": _reprDigest,
    ...headers
  } = endToEnd(answer.headers);
  response.writeHead(answer.status, answer.statusMessage, {
    ...headers,
    "content-length": body.length,
  });
  response.end(body);
};

/**
 * Starts the proxy with the additions `argv` names and prints one line saying
 * where it listens, where it forwards and what it adds where. A malformed or
 * refused rule, or a port that cannot be listened on, is refused with one
 * sentence.
 */
export const runAdditions = async (
  argv: readonly string[],
  say: (line: string) => void,
): Promise<Started> => {
  const read = readSettings(argv);
  if (!read.ok) {
    return read;
  }
  const { settings } = read;
  const basePath = settings.upstream.pathname.replace(/\/$/, "");
  const upstreamName = `${settings.upstream.origin}${basePath}`;
  const stamped = (words: string) => say(`${new Date().toISOString()} ${words}`);
  let sequence = 0;

  const exchange = async (n: number, request: IncomingMessage, response: ServerResponse) => {
    const callerLeft = () => response.destroyed || !request.socket.writable;
    const method = request.method ?? "";
    const path = (request.url ?? "").split("?", 1)[0] ?? "";
    const log = (words: string) => stamped(`#${n} ${method} ${path} ${words}`);

    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) chunks.push(chunk as Buffer);
    } catch {
      log("the caller left before its request was whole; nothing was forwarded");
      return;
    }

    let answer: Answer;
    try {
      answer = await forward(settings.upstream, basePath, request, Buffer.concat(chunks));
    } catch (error) {
      const code = codeOf(error);
      if (callerLeft()) {
        log(
          `no whole answer from the upstream (${code}), and the caller had left, so no 502 was sent`,
        );
        return;
      }
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(`The additions proxy got no whole answer from ${upstreamName}: ${code}.\n`);
      log(`no whole answer from the upstream (${code}); answered 502`);
      return;
    }

    const coding = String(answer.headers["content-encoding"] ?? "").trim();
    const facts = `${answer.status}, ${answer.body.length} ${coding === "" ? "bytes" : `encoded bytes (${coding})`}`;
    if (callerLeft()) {
      log(`${facts}: the caller had left before the answer was whole, so nothing was sent`);
      return;
    }

    const route = routeOf(method, path);
    const names =
      route === undefined
        ? []
        : settings.rules
            .filter(
              (rule) =>
                (ADDITIONS[rule.name].routes as readonly RouteName[]).includes(route) &&
                rule.matches(path),
            )
            .map((rule) => rule.name);
    if (route === undefined || names.length === 0) {
      passThrough(response, answer, method);
      log(`${facts}: passed through`);
      return;
    }

    const rewritten = rewrite(answer, route, names);
    if ("why" in rewritten) {
      passThrough(response, answer, method);
      log(`${facts}: passed through unchanged, because ${rewritten.why}`);
      return;
    }
    if (rewritten.edits.length === 0) {
      passThrough(response, answer, method);
      log(`${facts}: passed through unchanged; nothing in it takes ${names.join(" or ")}`);
      return;
    }
    sendRewritten(response, answer, rewritten.body);
    log(`${facts}: sent as ${rewritten.body.length} bytes with ${tally(rewritten.edits)}`);
  };

  const server = createServer((request, response) => {
    sequence += 1;
    const n = sequence;
    exchange(n, request, response).catch((error: unknown) => {
      const path = (request.url ?? "").split("?", 1)[0] ?? "";
      stamped(
        `#${n} ${request.method ?? ""} ${path} failed inside the proxy (${codeOf(error)}); the connection was closed`,
      );
      request.socket.destroy();
    });
  });

  const bound = await listen(server, settings.port);
  if (typeof bound !== "number") {
    return {
      ok: false,
      why: `Port ${settings.port} on 127.0.0.1 cannot be listened on (${bound.code}); --port takes another.`,
    };
  }

  say(
    `additions proxy on http://127.0.0.1:${bound}, forwarding to ${upstreamName}; every other answer passes through unchanged`,
  );
  for (const rule of settings.rules) {
    const addition: Addition = ADDITIONS[rule.name];
    say(
      `  ${rule.name}: ${addition.what}; ${rule.only === null ? "on" : `only where the path matches ${rule.only}, among`} ${answersOf(addition)}`,
    );
  }

  return {
    ok: true,
    proxy: {
      port: bound,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    },
  };
};
