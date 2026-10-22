/**
 * A model facilitator for the local stack, with at most one fault armed per
 * run.
 *
 * The gateway talks to its facilitator over two calls, verify and settle, and
 * reads every answer as one of three things: yes, no, or nobody knows. The
 * stories that test what a buyer, a merchant and the dashboard are told about
 * money need each of those on a purchase of the tester's choosing, which no
 * real facilitator gives on demand. This server answers both calls the way the
 * gateway's own x402 client expects, valid and settled, except the one call
 * the armed fault names.
 *
 * Nothing here signs, broadcasts or asks a chain. A "transfer" is an entry in
 * this process's memory, and every line that names one says it is a local
 * model. A chain other than Base Sepolia is refused without a verdict, so
 * even a gateway on the wrong chain hears nothing it could read as money.
 *
 * The log names the payment reference, the payer, the payee, the amount and
 * the first characters of the authorization's nonce. It never prints a
 * signature, the one part of a payment that could be sent on to a real
 * facilitator and spent.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getDefaultAsset } from "@x402/evm";

const FAULTS = ["verify-refused", "settle-failed", "settle-lost", "settle-late"] as const;
type Fault = (typeof FAULTS)[number];

const CALL_OF: Readonly<Record<Fault, "verify" | "settle">> = {
  "verify-refused": "verify",
  "settle-failed": "settle",
  "settle-lost": "settle",
  "settle-late": "settle",
};

/** The only chain this model answers for: its payments are test money even when real. */
const MODELLED_NETWORK = "eip155:84532";

/**
 * One of the two reasons the gateway's x402 adapter accepts as a refusal made
 * before anything was broadcast; any other failure it keeps as unknown.
 */
const REFUSED_BEFORE_BROADCAST = "invalid_exact_evm_recipient_mismatch";

const TAKES = {
  "--fault": FAULTS.join(", "),
  "--nth": "a whole number from 1 up",
  "--after": "a number of seconds from 0 to 600, with at most three decimals",
  "--port": "a port from 0 to 65535 to listen on at 127.0.0.1",
} as const;
type Flag = keyof typeof TAKES;

const DEFAULT_PORT = "8789";
const DEFAULT_LATE_SECONDS = "20";
const MOST_BODY_BYTES = 1 << 20;

interface Rule {
  readonly fault: Fault | null;
  readonly nth: number;
  readonly afterMs: number;
  readonly port: number;
}

interface PaymentFaults {
  readonly port: number;
  close(): Promise<void>;
}

type Started =
  | { readonly ok: true; readonly server: PaymentFaults }
  | { readonly ok: false; readonly why: string };

type Read =
  | { readonly ok: true; readonly rule: Rule }
  | { readonly ok: false; readonly why: string };

const isFlag = (token: string): token is Flag => Object.hasOwn(TAKES, token);

const refused = (why: string): Read => ({ ok: false, why });

const malformed = (flag: Flag, value: string): Read =>
  refused(`${flag} takes ${TAKES[flag]}, not ${JSON.stringify(value)}.`);

const readRule = (argv: readonly string[]): Read => {
  const given = new Map<Flag, string>();
  for (let at = 0; at < argv.length; at += 2) {
    const token = argv[at] ?? "";
    const value = argv[at + 1];
    if (!isFlag(token)) {
      const shown = token.startsWith("--") ? JSON.stringify(token) : "a bare value";
      return refused(
        `Expected one of --fault, --nth, --after or --port, each followed by its value after a space, and got ${shown}.`,
      );
    }
    if (value === undefined || value.startsWith("--")) {
      return refused(`${token} needs a value after it: ${TAKES[token]}.`);
    }
    if (given.has(token)) {
      return refused(`${token} is given twice, and one run arms one fault.`);
    }
    given.set(token, value);
  }

  const named = given.get("--fault");
  const fault = named === undefined ? null : (FAULTS.find((known) => known === named) ?? null);
  if (named !== undefined && fault === null) {
    return malformed("--fault", named);
  }
  if (fault === null && (given.has("--nth") || given.has("--after"))) {
    return refused("--nth and --after describe a fault, and no --fault is given.");
  }
  const nth = given.get("--nth") ?? "1";
  if (!/^[1-9]\d{0,14}$/.test(nth)) {
    return malformed("--nth", nth);
  }
  if (fault === "verify-refused" && given.has("--after")) {
    return refused(
      "--after delays a settle's answer, and verify-refused answers a verification; leave --after out.",
    );
  }
  const after = given.get("--after") ?? (fault === "settle-late" ? DEFAULT_LATE_SECONDS : "0");
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(after) || Number(after) > 600) {
    return malformed("--after", after);
  }
  const port = given.get("--port") ?? DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) {
    return malformed("--port", port);
  }

  return {
    ok: true,
    rule: {
      fault,
      nth: Number(nth),
      afterMs: Math.round(Number(after) * 1000),
      port: Number(port),
    },
  };
};

/** What one call to this facilitator presented, as far as it could be read. */
interface Presented {
  readonly network: string | null;
  readonly asset: string | null;
  readonly amount: string | null;
  readonly payTo: string | null;
  readonly paymentRef: string | null;
  readonly payer: string | null;
  readonly nonce: string | null;
}

const objectAt = (value: unknown, key: string): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "object" && found !== null ? (found as Record<string, unknown>) : null;
};

const textAt = (value: Record<string, unknown> | null, key: string): string | null => {
  const found = value?.[key];
  return typeof found === "string" ? found : null;
};

const presentedIn = (document: unknown): Presented => {
  const requirements = objectAt(document, "paymentRequirements");
  const authorization = objectAt(
    objectAt(objectAt(document, "paymentPayload"), "payload"),
    "authorization",
  );
  return {
    network: textAt(requirements, "network"),
    asset: textAt(requirements, "asset"),
    amount: textAt(requirements, "amount"),
    payTo: textAt(requirements, "payTo"),
    paymentRef: textAt(objectAt(requirements, "extra"), "payment_ref"),
    payer: textAt(authorization, "from"),
    nonce: textAt(authorization, "nonce"),
  };
};

/** The amount in USDC where the asset is Base Sepolia's USDC, and in atomic units of the named asset otherwise. */
const amountOf = (presented: Presented): string => {
  const { amount, asset } = presented;
  if (amount === null || !/^\d+$/.test(amount)) return "no readable amount";
  const usdc = getDefaultAsset(MODELLED_NETWORK);
  if (asset === null || asset.toLowerCase() !== usdc.asset.toLowerCase()) {
    return `${amount} atomic units of ${asset ?? "an unnamed asset"}`;
  }
  const whole = amount.padStart(usdc.decimals + 1, "0");
  const units = whole.slice(0, -usdc.decimals);
  const cents = whole.slice(-usdc.decimals).replace(/0+$/, "");
  return `${cents === "" ? units : `${units}.${cents}`} USDC`;
};

const describe = (presented: Presented): string =>
  [
    `payment_ref ${presented.paymentRef ?? "(none)"}`,
    `${amountOf(presented)} from ${presented.payer ?? "an unnamed payer"} to ${presented.payTo ?? "an unnamed payee"}`,
    `authorization ${presented.nonce === null ? "(no nonce)" : `${presented.nonce.slice(0, 10)}…`}`,
  ].join(", ");

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
};

const readBody = async (request: IncomingMessage): Promise<string | null> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MOST_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const listen = (
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<number | { readonly code: string }> =>
  new Promise((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolve({ code: error.code ?? "no error code" }),
    );
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

const armedWords = (rule: Rule): string => {
  if (rule.fault === null) {
    return "no fault is armed: every verification is answered valid and every settle settled";
  }
  const after = rule.afterMs === 0 ? "at once" : `after ${seconds(rule.afterMs)}`;
  const which = `${CALL_OF[rule.fault]} number ${rule.nth}`;
  const what: Record<Fault, string> = {
    "verify-refused": `${which} is answered invalid (insufficient_funds)`,
    "settle-failed": `${which} is answered ${after} as a definite failure, refused before broadcast (${REFUSED_BEFORE_BROADCAST})`,
    "settle-lost": `${which} is counted as a transfer in the model and its connection closed ${after} with no answer`,
    "settle-late": `${which} is held and answered settled ${after}`,
  };
  return `armed: ${what[rule.fault]}, once; every other call is answered valid or settled`;
};

/**
 * Starts the model facilitator by the rule `argv` describes and prints one line
 * saying where it listens, what it is, and which call it will break. A
 * malformed rule or a port that cannot be listened on is refused with one
 * sentence.
 */
export const runPaymentFaults = async (
  argv: readonly string[],
  say: (line: string) => void,
): Promise<Started> => {
  const read = readRule(argv);
  if (!read.ok) {
    return read;
  }
  const { rule } = read;
  const stamped = (words: string) => say(`${new Date().toISOString()} ${words}`);

  let sequence = 0;
  // Two runs number their transfers from 1, so the run's own mark keeps the
  // receipts of one run from naming the same transaction as another's.
  const run = randomBytes(3).toString("hex");
  const seen = { verify: 0, settle: 0 };
  /** The model's transfers, by payer and nonce: one authorization moves money once. */
  const transfers = new Map<string, { readonly transaction: string; readonly call: number }>();
  const timers = new Set<NodeJS.Timeout>();

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (ms === 0) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });

  /** The armed fault if this call is the one it names, counting the call; it names one call only. */
  const armedFor = (call: "verify" | "settle"): Fault | null => {
    seen[call] += 1;
    return rule.fault !== null && CALL_OF[rule.fault] === call && seen[call] === rule.nth
      ? rule.fault
      : null;
  };

  const spentLine = () =>
    stamped(
      "the fault is spent: every call is answered valid or settled from here on; a restart arms it again",
    );

  /** Counts a transfer in the model, or names the one this authorization already made. */
  const transfer = (presented: Presented, call: number): { transaction: string; again: string } => {
    const key = `${presented.payer ?? ""}:${presented.nonce ?? ""}`.toLowerCase();
    const earlier = transfers.get(key);
    if (earlier !== undefined) {
      return {
        transaction: earlier.transaction,
        again: `; this authorization was already counted as ${earlier.transaction} at #${earlier.call}, and a chain moves one authorization's money once, so no second transfer is counted`,
      };
    }
    const transaction = `local-model-${run}-${transfers.size + 1}`;
    transfers.set(key, { transaction, call });
    return { transaction, again: "" };
  };

  const verify = (n: number, presented: Presented, response: ServerResponse) => {
    const fault = armedFor("verify");
    const log = (words: string) => stamped(`#${n} verify ${describe(presented)}: ${words}`);
    if (fault === "verify-refused") {
      json(response, 200, {
        isValid: false,
        invalidReason: "insufficient_funds",
        invalidMessage:
          "Refused by the payment fault control on the local stack, as the fault it was armed with; no balance was read.",
        payer: presented.payer,
      });
      log(
        `answered invalid (insufficient_funds) as the armed fault, verify ${seen.verify} of ${rule.nth}`,
      );
      spentLine();
      return;
    }
    json(response, 200, { isValid: true, payer: presented.payer });
    log("answered valid; no signature or balance was checked");
  };

  const settle = async (
    n: number,
    presented: Presented,
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    const fault = armedFor("settle");
    const log = (words: string) => stamped(`#${n} settle ${describe(presented)}: ${words}`);
    const arrived = Date.now();
    let leftAt: number | null = null;
    // The response closes when its connection does; closing before anything
    // was written means the gateway stopped waiting.
    response.once("close", () => {
      if (response.writableEnded || leftAt !== null) return;
      leftAt = Date.now();
      if (fault !== null && rule.afterMs > 0) {
        log(
          `the gateway stopped waiting after ${seconds(leftAt - arrived)}, while the answer was held`,
        );
      }
    });
    const gone = () => leftAt !== null || response.destroyed || !request.socket.writable;
    const goneWords = () =>
      `the gateway closed the connection after ${seconds((leftAt ?? Date.now()) - arrived)}`;

    if (fault === "settle-lost") {
      const { transaction, again } = transfer(presented, n);
      log(
        `LOCAL MODEL transfer ${transaction} counted as done${again}; nothing moved on any chain. The answer is withheld as the armed fault`,
      );
      await wait(rule.afterMs);
      if (gone()) {
        log(`${goneWords()}, before the model closed it; the answer was lost either way`);
      } else {
        request.socket.destroy();
        log(`closed the connection after ${seconds(Date.now() - arrived)} with no answer`);
      }
      spentLine();
      return;
    }

    if (fault === "settle-failed") {
      await wait(rule.afterMs);
      if (gone()) {
        log(
          `${goneWords()}, before the armed failure was answered; no transfer is counted in the model`,
        );
        spentLine();
        return;
      }
      json(response, 200, {
        success: false,
        errorReason: REFUSED_BEFORE_BROADCAST,
        errorMessage:
          "Refused before broadcast by the payment fault control on the local stack, as the fault it was armed with.",
        transaction: "",
        network: presented.network ?? MODELLED_NETWORK,
        payer: presented.payer,
      });
      log(
        `answered after ${seconds(Date.now() - arrived)} as a definite failure before broadcast (${REFUSED_BEFORE_BROADCAST}), the armed fault; no transfer is counted in the model`,
      );
      spentLine();
      return;
    }

    if (fault === "settle-late") {
      log(`held as the armed fault, to be answered settled after ${seconds(rule.afterMs)}`);
      await wait(rule.afterMs);
    }
    const { transaction, again } = transfer(presented, n);
    if (gone()) {
      log(
        `${goneWords()}, before the answer; the LOCAL MODEL counts transfer ${transaction} as done${again}, and the success reached nobody`,
      );
    } else {
      json(response, 200, {
        success: true,
        transaction,
        network: presented.network ?? MODELLED_NETWORK,
        payer: presented.payer,
      });
      log(
        `answered settled after ${seconds(Date.now() - arrived)}: LOCAL MODEL transfer ${transaction}${again}; nothing moved on any chain`,
      );
    }
    if (fault === "settle-late") spentLine();
  };

  const exchange = async (n: number, request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "";
    const path = (request.url ?? "").split("?", 1)[0] ?? "";
    const call =
      method === "POST" && path === "/verify"
        ? "verify"
        : method === "POST" && path === "/settle"
          ? "settle"
          : null;
    if (call === null) {
      request.resume();
      json(response, 404, {
        error: "this model facilitator answers POST /verify and POST /settle only",
      });
      stamped(
        `#${n} ${method} ${path}: answered 404, this model answers POST /verify and POST /settle only`,
      );
      return;
    }

    const text = await readBody(request);
    let document: unknown = null;
    try {
      document = text === null ? null : JSON.parse(text);
    } catch {
      document = null;
    }
    if (typeof document !== "object" || document === null) {
      json(response, 400, { error: "the body is not a JSON document of at most 1 MiB" });
      stamped(
        `#${n} ${call}: answered 400, the body is not a JSON document of at most 1 MiB; not counted`,
      );
      return;
    }
    const presented = presentedIn(document);
    if (presented.network !== MODELLED_NETWORK) {
      json(response, 400, {
        error: `this model facilitator answers for ${MODELLED_NETWORK} (Base Sepolia) only`,
      });
      stamped(
        `#${n} ${call} on ${presented.network ?? "no named chain"}: answered 400 with no verdict, this model answers for ${MODELLED_NETWORK} only; not counted`,
      );
      return;
    }
    if (call === "verify") {
      verify(n, presented, response);
    } else {
      await settle(n, presented, request, response);
    }
  };

  const server = createServer((request, response) => {
    sequence += 1;
    const n = sequence;
    exchange(n, request, response).catch(() => {
      stamped(`#${n} failed inside the model facilitator; the connection was closed`);
      request.socket.destroy();
    });
  });

  const bound = await listen(server, rule.port);
  if (typeof bound !== "number") {
    return {
      ok: false,
      why: `Port ${rule.port} on 127.0.0.1 cannot be listened on (${bound.code}); --port takes another.`,
    };
  }

  say(
    `payment fault control: a model facilitator on http://127.0.0.1:${bound} for ${MODELLED_NETWORK}. ` +
      "It signs, broadcasts and asks nothing; every transfer it reports is a LOCAL MODEL, not money on any chain. " +
      `A stack in Docker reaches it as http://host.docker.internal:${bound}. ${armedWords(rule)}`,
  );

  return {
    ok: true,
    server: {
      port: bound,
      close: () =>
        new Promise((resolve) => {
          for (const timer of timers) clearTimeout(timer);
          timers.clear();
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    },
  };
};
