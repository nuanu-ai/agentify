/**
 * The controlled Woo fault: the TLS edge in front of a local copy of the
 * WooCommerce lab, through which the dashboard's connector reaches the shop.
 *
 * It answers for two names. Requests for the shop's name go to the lab's
 * WordPress and are where faults happen: a chosen request failed before or
 * after the shop saw it, the request that creates a chosen Agentify order held
 * until it is released by that order's identifier, and that order's total
 * shifted by a fee line the shop records. Requests for the dashboard's name go
 * to the stack untouched, so that the shop's browser hand-over and its key
 * callback reach a dashboard served over https.
 *
 * The log never prints a header, a body or a query string: the connector's
 * keys travel in headers, and a buyer's address and email in an order's body.
 */

import { readFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { urlToHttpOptions } from "node:url";

/** The one path the connector creates a shop order at, for a download and a parcel alike. */
const ORDERS_PATH = "/wp-json/wc/v3/orders";

const FAULTS = "a status from 400 to 599, malformed, drop or cut";

type Fault =
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "malformed" }
  | { readonly kind: "drop" }
  | { readonly kind: "cut" };

interface FailRule {
  readonly method: string;
  readonly path: string;
  readonly pattern: RegExp;
  readonly fault: Fault;
  /** How many more matching requests it fails; null fails every one until cleared. */
  left: number | null;
}

/** One order-creating request waiting at a hold. */
interface Parked {
  readonly n: number;
  readonly since: Date;
  readonly callerLeft: () => boolean;
  readonly go: () => void;
}

interface Hold {
  /** Null until a hold armed for the next order meets one. */
  order: string | null;
  readonly parked: Parked[];
}

interface Shift {
  readonly order: string | null;
  readonly by: string;
}

/** What reached the edge for one Agentify order's shop order, and what reached the shop. */
interface Creations {
  arrived: number;
  sentToShop: number;
}

export interface EdgeOptions {
  /** The name the connector and the browser use for the shop, such as shop.woo-fault.test. */
  readonly shopHost: string;
  /** The lab copy's WordPress, over plain http. */
  readonly shop: URL;
  readonly dashboardHost: string;
  /** The stack's dashboard listener; everything under /dashboard goes there. */
  readonly dashboard: URL;
  /** The stack's gateway listener; every other path of the dashboard's name goes there. */
  readonly gateway: URL;
}

export interface Said {
  readonly ok: boolean;
  readonly said: string;
}

export interface Edge {
  readonly handle: (request: IncomingMessage, response: ServerResponse) => void;
  readonly control: (argv: readonly string[]) => Said;
}

interface Answer {
  readonly status: number;
  readonly statusMessage: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** `*` is any run of characters within one path segment, `**` any run across segments. */
const patternOf = (path: string): RegExp =>
  new RegExp(
    `^${path
      .split("**")
      .map((across) =>
        across
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*")}$`,
  );

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const endToEnd = (headers: IncomingHttpHeaders): OutgoingHttpHeaders =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)));

const wholeBody = async (message: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of message) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === undefined ? "no error code" : String(code);
};

/**
 * Sends the request on as it arrived, with the name the caller asked for, which
 * WordPress compares with its own address, and the scheme the caller used,
 * which WordPress and WooCommerce read to decide that the request came over
 * https.
 */
const forward = (
  upstream: URL,
  incoming: IncomingMessage,
  body: Buffer,
  host: string,
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = {
      ...endToEnd(incoming.headers),
      host,
      "x-forwarded-proto": "https",
      "x-forwarded-host": host,
      "x-forwarded-for": incoming.socket.remoteAddress ?? "",
      "content-length": body.length,
    };
    const outgoing = httpRequest(
      {
        ...urlToHttpOptions(upstream),
        path: incoming.url ?? "/",
        method: incoming.method,
        headers,
        agent: false,
      },
      (answer) => {
        wholeBody(answer).then(
          (answerBody) =>
            resolve({
              status: answer.statusCode ?? 0,
              statusMessage: answer.statusMessage ?? "",
              headers: answer.headers,
              body: answerBody,
            }),
          reject,
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });

const passThrough = (response: ServerResponse, answer: Answer, method: string): void => {
  response.writeHead(
    answer.status,
    answer.statusMessage,
    method === "HEAD"
      ? endToEnd(answer.headers)
      : { ...endToEnd(answer.headers), "content-length": answer.body.length },
  );
  response.end(answer.body);
};

/** The Agentify order an order-creating body names, from its metadata or, failing that, its transaction. */
const orderNamedIn = (body: Buffer): string | null => {
  try {
    const document = JSON.parse(body.toString("utf8")) as {
      meta_data?: unknown;
      transaction_id?: unknown;
    };
    if (Array.isArray(document.meta_data)) {
      for (const one of document.meta_data) {
        const entry = one as { key?: unknown; value?: unknown } | null;
        if (entry?.key === "agentify_order_id" && typeof entry.value === "string") {
          return entry.value;
        }
      }
    }
    return typeof document.transaction_id === "string" && document.transaction_id !== ""
      ? document.transaction_id
      : null;
  } catch {
    return null;
  }
};

/** The shop order an answer to an order-creating request names, as its line says it. */
const shopOrderNote = (answer: Answer): string => {
  const coding = (answer.headers["content-encoding"] ?? "").trim();
  if (coding !== "") {
    return `, shop order not read because the answer is encoded as ${coding}`;
  }
  try {
    const document = JSON.parse(answer.body.toString("utf8")) as { id?: unknown };
    return typeof document.id === "number" ? `, naming shop order ${document.id}` : "";
  } catch {
    return ", not JSON";
  }
};

/**
 * Adds one fee line to an order-creating body. The fee is untaxed, so the
 * shop's total moves by exactly the amount and its tax lines stay as they were.
 */
const shifted = (body: Buffer, by: string): Buffer | null => {
  try {
    const document = JSON.parse(body.toString("utf8")) as { fee_lines?: unknown };
    const fees = Array.isArray(document.fee_lines) ? document.fee_lines : [];
    return Buffer.from(
      JSON.stringify({
        ...document,
        fee_lines: [
          ...fees,
          { name: `Controlled Woo fault: total shifted by ${by}`, total: by, tax_status: "none" },
        ],
      }),
    );
  } catch {
    return null;
  }
};

const FAILED_BODY = JSON.stringify({
  code: "woo_fault",
  message: "Answered by the controlled Woo fault; the shop never saw this request.",
});

/** Ends with a JSON document cut off midway, so that no parser reads it. */
const MALFORMED_BODY = '{"id":42,"name":"Answered by the controlled Woo fault","prices":{"pri';

// --- The control commands ---------------------------------------------------

const ORDER = /^[A-Za-z0-9_.:-]{1,128}$/;
const AMOUNT = /^-?\d{1,12}(\.\d{1,4})?$/;

type Flags = ReadonlyMap<string, string>;

const flagsOf = (
  argv: readonly string[],
  takes: Readonly<Record<string, string>>,
  bare: readonly string[] = [],
): Flags | string => {
  const given = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at] ?? "";
    if (bare.includes(token)) {
      if (given.has(token)) return `${token} is given twice.`;
      given.set(token, "");
      continue;
    }
    const takes1 = takes[token];
    if (takes1 === undefined) {
      const known = [...Object.keys(takes), ...bare].join(", ");
      return `Expected ${known === "" ? "nothing more" : `one of ${known}`}, and got ${JSON.stringify(token)}.`;
    }
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) {
      return `${token} needs a value after it: ${takes1}.`;
    }
    if (given.has(token)) return `${token} is given twice.`;
    given.set(token, value);
    at += 1;
  }
  return given;
};

const faultOf = (value: string): Fault | null => {
  if (value === "malformed" || value === "drop" || value === "cut") return { kind: value };
  if (/^[45]\d\d$/.test(value)) return { kind: "status", status: Number(value) };
  return null;
};

const faultNamed = (fault: Fault): string => {
  switch (fault.kind) {
    case "status":
      return `answered ${fault.status} by the edge, never sent to the shop`;
    case "malformed":
      return "answered 200 with a JSON document cut off midway by the edge, never sent to the shop";
    case "drop":
      return "the connection closed by the edge with no answer, never sent to the shop";
    case "cut":
      return "sent to the shop, its whole answer read, then the connection closed with nothing written to the caller";
  }
};

const ruleNamed = (rule: FailRule): string =>
  `${rule.method} ${rule.path}: ${faultNamed(rule.fault)}; ${
    rule.left === null ? "every match until cleared" : `${rule.left} more`
  }`;

// --- The edge ---------------------------------------------------------------

export const wooFaultEdge = (options: EdgeOptions, say: (line: string) => void): Edge => {
  const stamped = (words: string) => say(`${new Date().toISOString()} ${words}`);
  const fails: FailRule[] = [];
  const holds: Hold[] = [];
  const shifts: Shift[] = [];
  const creations = new Map<string, Creations>();
  let sequence = 0;

  const holdFor = (order: string): Hold | null => {
    const exact = holds.find((one) => one.order === order);
    if (exact !== undefined) return exact;
    const next = holds.find((one) => one.order === null);
    if (next === undefined) return null;
    next.order = order;
    return next;
  };

  const takeShift = (order: string): Shift | null => {
    const at = shifts.findIndex((one) => one.order === order);
    const index = at === -1 ? shifts.findIndex((one) => one.order === null) : at;
    if (index === -1) return null;
    const [taken] = shifts.splice(index, 1);
    return taken ?? null;
  };

  const failFor = (method: string, path: string): FailRule | null => {
    const rule = fails.find((one) => one.method === method && one.pattern.test(path));
    if (rule === undefined) return null;
    if (rule.left !== null) {
      rule.left -= 1;
      if (rule.left === 0) fails.splice(fails.indexOf(rule), 1);
    }
    return rule;
  };

  const toShop = async (n: number, request: IncomingMessage, response: ServerResponse) => {
    const callerLeft = () => response.destroyed || !request.socket.writable;
    const method = request.method ?? "";
    const path = (request.url ?? "").split("?", 1)[0] ?? "";
    let body: Buffer;
    try {
      body = await wholeBody(request);
    } catch {
      stamped(`#${n} ${method} ${path}: the caller left before its request was whole; not sent`);
      return;
    }
    const creating = method === "POST" && path === ORDERS_PATH;
    const order = creating ? orderNamedIn(body) : null;
    const label = `#${n} ${method} ${path}${
      creating
        ? order === null
          ? " (creates an order; no Agentify order read)"
          : ` (creates the shop order for ${order})`
        : ""
    }`;
    const log = (words: string) => stamped(`${label}: ${words}`);
    const count = order === null ? null : (creations.get(order) ?? { arrived: 0, sentToShop: 0 });
    if (order !== null && count !== null) {
      count.arrived += 1;
      creations.set(order, count);
    }

    const hold = order === null ? null : holdFor(order);
    if (hold !== null) {
      log("HELD before the shop; release it by this order's identifier");
      await new Promise<void>((resolve) => {
        hold.parked.push({ n, since: new Date(), callerLeft, go: resolve });
      });
      if (callerLeft()) {
        log("released, but its caller had already given up, so it was never sent to the shop");
        return;
      }
      log("released; going on to the shop");
    }

    const rule = failFor(method, path);
    if (rule !== null && rule.fault.kind !== "cut") {
      if (rule.fault.kind === "drop") {
        response.socket?.destroy();
      } else {
        const status = rule.fault.kind === "status" ? rule.fault.status : 200;
        const answer = rule.fault.kind === "status" ? FAILED_BODY : MALFORMED_BODY;
        response.writeHead(status, {
          "content-type": "application/json; charset=UTF-8",
          "content-length": Buffer.byteLength(answer),
        });
        response.end(answer);
      }
      log(`FAILED: ${faultNamed(rule.fault)}`);
      return;
    }

    let sent = body;
    let shiftNote = "";
    const shift = order === null ? null : takeShift(order);
    if (shift !== null) {
      const changed = shifted(body, shift.by);
      if (changed === null) {
        log(`its body is not JSON, so the shift by ${shift.by} was not applied and is spent`);
      } else {
        sent = changed;
        shiftNote = `, its total shifted by ${shift.by} with a fee line`;
      }
    }

    let answer: Answer;
    if (order !== null && count !== null) count.sentToShop += 1;
    try {
      answer = await forward(options.shop, request, sent, options.shopHost);
    } catch (error) {
      if (callerLeft()) {
        log(
          `sent to the shop${shiftNote}; no whole answer (${codeOf(error)}) and the caller had left`,
        );
        return;
      }
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        `The controlled Woo fault got no whole answer from the shop: ${codeOf(error)}.\n`,
      );
      log(`sent to the shop${shiftNote}; no whole answer (${codeOf(error)}), answered 502`);
      return;
    }
    const facts = `${answer.status}, ${answer.body.length} bytes${creating ? shopOrderNote(answer) : ""}`;
    if (rule !== null) {
      response.socket?.destroy();
      log(`sent to the shop${shiftNote}, which answered ${facts}; CUT: ${faultNamed(rule.fault)}`);
      return;
    }
    if (callerLeft()) {
      log(
        `sent to the shop${shiftNote}, which answered ${facts}; the caller had left, so nothing reached it`,
      );
      return;
    }
    passThrough(response, answer, method);
    log(`sent to the shop${shiftNote}, which answered ${facts}; passed back`);
  };

  /** The stack, untouched and unlogged: the dashboard's pages, the key callback and the gateway. */
  const toStack = async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "/";
    const upstream =
      path === "/dashboard" || path.startsWith("/dashboard/") || path.startsWith("/dashboard?")
        ? options.dashboard
        : options.gateway;
    const body = await wholeBody(request);
    try {
      passThrough(
        response,
        await forward(upstream, request, body, options.dashboardHost),
        request.method ?? "",
      );
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        `The controlled Woo fault got no whole answer from the stack: ${codeOf(error)}.\n`,
      );
    }
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const host = (request.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (host === options.shopHost) {
      sequence += 1;
      const n = sequence;
      toShop(n, request, response).catch((error: unknown) => {
        stamped(`#${n} failed inside the edge (${codeOf(error)}); the connection was closed`);
        request.socket.destroy();
      });
      return;
    }
    if (host === options.dashboardHost) {
      toStack(request, response).catch(() => request.socket.destroy());
      return;
    }
    response.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
    response.end(`This edge answers only for ${options.shopHost} and ${options.dashboardHost}.\n`);
  };

  const status = (): string => {
    const lines = [`Shop ${options.shopHost} -> ${options.shop.origin}`];
    lines.push(
      fails.length === 0
        ? "Failing: nothing"
        : `Failing, first match wins:\n${fails.map((rule) => `  ${ruleNamed(rule)}`).join("\n")}`,
    );
    lines.push(
      holds.length === 0
        ? "Holding: nothing"
        : `Holding:\n${holds
            .map((hold) => {
              const waiting = hold.parked.filter((one) => !one.callerLeft());
              const gone = hold.parked.length - waiting.length;
              const named = hold.order ?? "the next order created";
              const parked =
                hold.parked.length === 0
                  ? "nothing has arrived yet"
                  : [
                      ...waiting.map((one) => `#${one.n} waiting since ${one.since.toISOString()}`),
                      ...(gone > 0
                        ? [`${gone} whose caller gave up, which release will not send`]
                        : []),
                    ].join("; ");
              return `  ${named}: ${parked}`;
            })
            .join("\n")}`,
    );
    lines.push(
      shifts.length === 0
        ? "Shifting: nothing"
        : `Shifting:\n${shifts
            .map((one) => `  ${one.order ?? "the next order created"} by ${one.by}`)
            .join("\n")}`,
    );
    lines.push(
      creations.size === 0
        ? "Order-creating requests: none yet"
        : `Order-creating requests, by Agentify order:\n${[...creations]
            .map(
              ([order, seen]) =>
                `  ${order}: ${seen.arrived} arrived, ${seen.sentToShop} sent on to the shop`,
            )
            .join("\n")}`,
    );
    return lines.join("\n");
  };

  const orderFlag = (flags: Flags, verb: string): string | null | Said => {
    const order = flags.get("--order");
    const next = flags.has("--next");
    if ((order === undefined) === !next) {
      return { ok: false, said: `${verb} takes either --order <Agentify order id> or --next.` };
    }
    if (order !== undefined && !ORDER.test(order)) {
      return {
        ok: false,
        said: `--order takes an Agentify order identifier, not ${JSON.stringify(order)}.`,
      };
    }
    return order ?? null;
  };

  const control = (argv: readonly string[]): Said => {
    const [verb, ...rest] = argv;
    switch (verb) {
      case "status": {
        const flags = flagsOf(rest, {});
        if (typeof flags === "string") return { ok: false, said: flags };
        return { ok: true, said: status() };
      }
      case "fail": {
        const flags = flagsOf(rest, {
          "--method": "an HTTP method in capitals, such as GET",
          "--path": "a path pattern without a query, such as '/wp-json/wc/v3/products/*'",
          "--fault": FAULTS,
          "--count": "a whole number from 1 up, or all",
        });
        if (typeof flags === "string") return { ok: false, said: flags };
        const method = flags.get("--method") ?? "";
        const path = flags.get("--path") ?? "";
        const fault = faultOf(flags.get("--fault") ?? "");
        const count = flags.get("--count") ?? "1";
        if (!/^[A-Z]+$/.test(method))
          return { ok: false, said: "--method takes an HTTP method in capitals, such as GET." };
        if (!path.startsWith("/") || path.includes("?")) {
          return {
            ok: false,
            said: "--path takes a path pattern that starts with / and has no query.",
          };
        }
        if (fault === null) return { ok: false, said: `--fault takes ${FAULTS}.` };
        if (count !== "all" && !/^[1-9]\d{0,5}$/.test(count)) {
          return { ok: false, said: "--count takes a whole number from 1 up, or all." };
        }
        const rule: FailRule = {
          method,
          path,
          pattern: patternOf(path),
          fault,
          left: count === "all" ? null : Number(count),
        };
        fails.push(rule);
        return { ok: true, said: `Armed: ${ruleNamed(rule)}.` };
      }
      case "hold": {
        const flags = flagsOf(rest, { "--order": "an Agentify order identifier" }, ["--next"]);
        if (typeof flags === "string") return { ok: false, said: flags };
        const order = orderFlag(flags, "hold");
        if (typeof order === "object" && order !== null) return order;
        if (holds.some((one) => one.order === order)) {
          return { ok: false, said: `A hold for ${order ?? "the next order"} is already armed.` };
        }
        holds.push({ order, parked: [] });
        return {
          ok: true,
          said:
            order === null
              ? "Armed: the next order-creating request is held before the shop, whichever order it names; status names it."
              : `Armed: every request creating the shop order for ${order} is held before the shop until released.`,
        };
      }
      case "release": {
        const flags = flagsOf(rest, { "--order": "an Agentify order identifier" });
        if (typeof flags === "string") return { ok: false, said: flags };
        const order = flags.get("--order");
        if (order === undefined)
          return { ok: false, said: "release takes --order <Agentify order id>." };
        const hold = holds.find((one) => one.order === order);
        if (hold === undefined) {
          return {
            ok: false,
            said: `Nothing is held for ${order}, and no hold is armed for it; nothing was released.`,
          };
        }
        holds.splice(holds.indexOf(hold), 1);
        const waiting = hold.parked.filter((one) => !one.callerLeft()).length;
        const gone = hold.parked.length - waiting;
        for (const one of hold.parked) one.go();
        return {
          ok: true,
          said:
            `Released ${order}: ${waiting} request${waiting === 1 ? "" : "s"} sent on to the shop` +
            `${gone > 0 ? `, ${gone} not sent because ${gone === 1 ? "its caller" : "their callers"} had given up` : ""}; the hold is disarmed.`,
        };
      }
      case "shift": {
        const flags = flagsOf(
          rest,
          { "--order": "an Agentify order identifier", "--by": "an amount such as 1 or -0.01" },
          ["--next"],
        );
        if (typeof flags === "string") return { ok: false, said: flags };
        const order = orderFlag(flags, "shift");
        if (typeof order === "object" && order !== null) return order;
        const by = flags.get("--by") ?? "";
        if (!AMOUNT.test(by) || !/[1-9]/.test(by)) {
          return {
            ok: false,
            said: "--by takes a non-zero amount in the shop's currency, written with a dot and no separators, such as 1 or -0.01.",
          };
        }
        shifts.push({ order, by });
        return {
          ok: true,
          said: `Armed: the shop order created for ${order ?? "the next order"} gets a fee line of ${by}, once.`,
        };
      }
      case "clear": {
        const flags = flagsOf(rest, {});
        if (typeof flags === "string") return { ok: false, said: flags };
        const waiting = holds.filter((one) => one.parked.length > 0);
        fails.splice(0);
        shifts.splice(0);
        holds.splice(0, holds.length, ...waiting);
        return {
          ok: true,
          said:
            "Cleared every failure, every shift and every hold that has caught nothing" +
            (waiting.length > 0
              ? `; ${waiting.length} hold${waiting.length === 1 ? "" : "s"} with requests waiting stay until released.`
              : "."),
        };
      }
      default:
        return {
          ok: false,
          said: "Expected one of status, fail, hold, release, shift or clear.",
        };
    }
  };

  return { handle, control };
};

// --- Serving and commanding -------------------------------------------------

const listen = (server: Server, port: number, host: string): Promise<number | string> =>
  new Promise((resolve) => {
    server.once("error", (error) => resolve(codeOf(error)));
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });

const SERVE_TAKES = {
  "--shop-host": "the shop's name, such as shop.woo-fault.test",
  "--shop": "the lab copy's WordPress as an http URL, such as http://woo-fault-wordpress",
  "--dashboard-host": "the dashboard's name, such as agentify.woo-fault.test",
  "--dashboard": "the stack's dashboard listener as an http URL",
  "--gateway": "the stack's gateway listener as an http URL",
  "--cert": "the edge certificate's PEM file",
  "--key": "the edge key's PEM file",
  "--port": "the port the edge listens on for TLS",
  "--control-port": "the port the control commands are posted to",
} as const;

const plainHttp = (value: string): URL | null => {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "http:" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.username === ""
    ? url
    : null;
};

/** Starts the edge and its control listener; the edge listens for TLS on every interface of its container. */
export const serveWooFault = async (
  argv: readonly string[],
  say: (line: string) => void,
): Promise<Said> => {
  const flags = flagsOf(argv, SERVE_TAKES);
  if (typeof flags === "string") return { ok: false, said: flags };
  for (const flag of Object.keys(SERVE_TAKES)) {
    if (!flags.has(flag))
      return {
        ok: false,
        said: `${flag} is required: ${SERVE_TAKES[flag as keyof typeof SERVE_TAKES]}.`,
      };
  }
  const shop = plainHttp(flags.get("--shop") ?? "");
  const dashboard = plainHttp(flags.get("--dashboard") ?? "");
  const gateway = plainHttp(flags.get("--gateway") ?? "");
  if (shop === null || dashboard === null || gateway === null) {
    return {
      ok: false,
      said: "--shop, --dashboard and --gateway each take a plain http URL with no path, such as http://woo-fault-wordpress; the edge never speaks TLS to what it fronts.",
    };
  }
  const shopHost = (flags.get("--shop-host") ?? "").toLowerCase();
  const dashboardHost = (flags.get("--dashboard-host") ?? "").toLowerCase();
  if (!shopHost.endsWith(".test") || !dashboardHost.endsWith(".test")) {
    return {
      ok: false,
      said: "--shop-host and --dashboard-host must end in .test, a name no public resolver answers, so that a caller the edge is not wired into fails to resolve rather than reaching a real site.",
    };
  }
  const edge = wooFaultEdge({ shopHost, shop, dashboardHost, dashboard, gateway }, say);
  let tls: Server;
  try {
    tls = createTlsServer(
      {
        cert: readFileSync(flags.get("--cert") ?? ""),
        key: readFileSync(flags.get("--key") ?? ""),
      },
      edge.handle,
    );
  } catch (error) {
    return {
      ok: false,
      said: `The edge's certificate or key could not be read (${codeOf(error)}).`,
    };
  }
  const control = createServer((request, response) => {
    wholeBody(request)
      .then((body) => {
        let argv: unknown;
        try {
          argv = (JSON.parse(body.toString("utf8")) as { argv?: unknown }).argv;
        } catch {
          argv = undefined;
        }
        const said =
          request.method === "POST" &&
          Array.isArray(argv) &&
          argv.every((one) => typeof one === "string")
            ? edge.control(argv)
            : { ok: false, said: 'Post {"argv": [...]} as the woo-fault command does.' };
        if (said.ok && argv !== undefined && (argv as string[])[0] !== "status") {
          say(`${new Date().toISOString()} control: ${said.said}`);
        }
        response.writeHead(said.ok ? 200 : 400, { "content-type": "application/json" });
        response.end(JSON.stringify(said));
      })
      .catch(() => request.socket.destroy());
  });
  const port = Number(flags.get("--port"));
  const controlPort = Number(flags.get("--control-port"));
  const bound = await listen(tls, port, "0.0.0.0");
  if (typeof bound === "string")
    return { ok: false, said: `Port ${port} cannot be listened on (${bound}).` };
  const boundControl = await listen(control, controlPort, "0.0.0.0");
  if (typeof boundControl === "string") {
    return { ok: false, said: `Port ${controlPort} cannot be listened on (${boundControl}).` };
  }
  return {
    ok: true,
    said: `controlled Woo fault: TLS on ${bound} for ${shopHost} -> ${shop.origin} (faults apply here) and ${dashboardHost} -> ${dashboard.origin} under /dashboard, ${gateway.origin} otherwise; control on ${boundControl}; nothing armed`,
  };
};

/** The control listener as the stack publishes it on the organiser's machine. */
const DEFAULT_CONTROL = "http://127.0.0.1:18622";

/** Posts one control command to a running edge and returns what it said. */
export const commandWooFault = async (
  argv: readonly string[],
  control: string = process.env.WOO_FAULT_CONTROL ?? DEFAULT_CONTROL,
): Promise<Said> => {
  try {
    const answered = await fetch(`${control}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv }),
      signal: AbortSignal.timeout(5_000),
    });
    return (await answered.json()) as Said;
  } catch (error) {
    return {
      ok: false,
      said: `No controlled Woo fault answered at ${control} (${codeOf((error as { cause?: unknown }).cause ?? error)}); is its stack up?`,
    };
  }
};
