/**
 * A loopback proxy that loses one answer after the server committed it.
 *
 * Several money stories turn on an answer that never reaches its caller once
 * the server has done the work: a paid purchase, a publish, a handler's
 * answer, a delivery, a refusal. Killing the caller on a timer proves nothing
 * about the server, so this proxy reads the upstream's whole answer before it
 * decides anything, and only a complete 2xx answer counts as a commitment that
 * may be cut. One rule per run: the nth matching 2xx answer is dropped before
 * its headers or midway through its body, and from then on everything passes.
 *
 * The log never prints headers, bodies or query strings: merchant keys and
 * payment signatures travel in headers, goods and addresses in bodies.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { urlToHttpOptions } from "node:url";

const PHASES = ["before-headers", "mid-body"] as const;
type Phase = (typeof PHASES)[number];

const TAKES = {
  "--to":
    "the upstream's http or https base URL with no query or fragment, such as https://gateway.example",
  "--port": "a port from 0 to 65535 to listen on at 127.0.0.1",
  "--method": "an HTTP method in capitals, such as POST",
  "--path": "a path pattern that starts with / and has no query string, such as /x402/*/purchase",
  "--phase": "before-headers or mid-body",
  "--nth": "a whole number from 1 up",
} as const;
type Flag = keyof typeof TAKES;

const REQUIRED: readonly Flag[] = ["--to", "--method", "--path", "--phase"];
const DEFAULT_PORT = "8788";

interface Rule {
  readonly upstream: URL;
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly phase: Phase;
  readonly nth: number;
}

interface CutProxy {
  readonly port: number;
  close(): Promise<void>;
}

type Started =
  | { readonly ok: true; readonly proxy: CutProxy }
  | { readonly ok: false; readonly why: string };

type Read =
  | { readonly ok: true; readonly rule: Rule }
  | { readonly ok: false; readonly why: string };

/** One upstream answer, read to its end. */
interface Answer {
  readonly status: number;
  readonly statusMessage: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

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
      // Shown only up to its `=`: what follows could be an upstream with a
      // password in it.
      const shown = token.startsWith("--") ? `"${token.replace(/=.*/s, "=…")}"` : "a bare value";
      return refused(
        `Expected one of --to, --port, --method, --path, --phase or --nth, each followed by its value after a space, and got ${shown}.`,
      );
    }
    if (value === undefined || value.startsWith("--")) {
      return refused(`${token} needs a value after it: ${TAKES[token]}.`);
    }
    if (given.has(token)) {
      return refused(`${token} is given twice, and one run cuts by one rule.`);
    }
    given.set(token, value);
  }
  for (const flag of REQUIRED) {
    if (!given.has(flag)) {
      return refused(`${flag} is required: ${TAKES[flag]}.`);
    }
  }

  const to = given.get("--to") ?? "";
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
    return refused(`--to takes ${TAKES["--to"]}, and the value given is not one.`);
  }

  const port = given.get("--port") ?? DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) {
    return malformed("--port", port);
  }
  const method = given.get("--method") ?? "";
  if (!/^[A-Z]+$/.test(method)) {
    return malformed("--method", method);
  }
  const path = given.get("--path") ?? "";
  if (!path.startsWith("/") || path.includes("?")) {
    return malformed("--path", path);
  }
  const phase = PHASES.find((known) => known === given.get("--phase"));
  if (phase === undefined) {
    return malformed("--phase", given.get("--phase") ?? "");
  }
  const nth = given.get("--nth") ?? "1";
  if (!/^[1-9]\d{0,14}$/.test(nth)) {
    return malformed("--nth", nth);
  }

  return {
    ok: true,
    rule: { upstream, port: Number(port), method, path, phase, nth: Number(nth) },
  };
};

const patternOf = (path: string): RegExp =>
  new RegExp(
    `^${path
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
  );

/**
 * Headers that describe one connection rather than the message. A chunked
 * `transfer-encoding` carried across would contradict the length the body is
 * sent with on the other side, where it always travels whole.
 */
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

/**
 * Sends the request on with its target appended to the base path exactly as it
 * arrived. Parsing it into a URL would resolve dot segments and send the
 * upstream a different path from the one the caller asked for.
 */
const forward = (
  upstream: URL,
  basePath: string,
  incoming: IncomingMessage,
  body: Buffer,
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const options = {
      ...urlToHttpOptions(upstream),
      path: `${basePath}${incoming.url ?? "/"}`,
      method: incoming.method,
      headers: { ...endToEnd(incoming.headers), host: upstream.host },
      // A fresh connection each time: a pooled one the upstream has closed
      // would turn into a reset, and a reset here reads as the upstream's.
      agent: false,
    };
    const outgoing = send(options, (answer) => {
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
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });

/** The order an answer names; one named in the path already shows in the line. */
const orderOf = (answer: Answer): string | null => {
  try {
    const document: unknown = JSON.parse(answer.body.toString("utf8"));
    if (typeof document === "object" && document !== null && "order_id" in document) {
      return typeof document.order_id === "string" ? document.order_id : null;
    }
  } catch {
    // Not JSON, or not readable as JSON: there is no order to name.
  }
  return null;
};

const passThrough = (response: ServerResponse, answer: Answer): void => {
  response.writeHead(answer.status, answer.statusMessage, {
    ...endToEnd(answer.headers),
    "content-length": answer.body.length,
  });
  response.end(answer.body);
};

/** Cuts the answer at its phase and says how many body bytes reached the caller. */
const cut = (response: ServerResponse, answer: Answer, phase: Phase): Promise<number> => {
  const socket = response.socket;
  if (phase === "before-headers" || socket === null) {
    socket?.destroy();
    return Promise.resolve(0);
  }
  const half = Math.floor(answer.body.length / 2);
  response.writeHead(answer.status, answer.statusMessage, {
    ...endToEnd(answer.headers),
    "content-length": answer.body.length,
  });
  return new Promise((resolve) => {
    response.write(answer.body.subarray(0, half), () => {
      socket.end();
      resolve(half);
    });
  });
};

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === undefined ? "no error code" : String(code);
};

const listen = (
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<number | { readonly code: string }> =>
  new Promise((resolve) => {
    server.once("error", (error) => resolve({ code: codeOf(error) }));
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

/**
 * Starts the proxy by the rule `argv` describes and prints one line saying
 * where it listens, where it forwards and which answer it cuts. A malformed
 * rule or a port that cannot be listened on is refused with one sentence.
 */
export const runCut = async (
  argv: readonly string[],
  say: (line: string) => void,
): Promise<Started> => {
  const read = readRule(argv);
  if (!read.ok) {
    return read;
  }
  const { rule } = read;
  const pattern = patternOf(rule.path);
  const basePath = rule.upstream.pathname.replace(/\/$/, "");
  const upstreamName = `${rule.upstream.origin}${basePath}`;
  const stamped = (words: string) => say(`${new Date().toISOString()} ${words}`);

  let sequence = 0;
  /** Matching 2xx answers seen whole; the rule is spent once this reaches nth. */
  let counted = 0;

  const exchange = async (n: number, request: IncomingMessage, response: ServerResponse) => {
    let callerGone = false;
    response.once("close", () => {
      callerGone = true;
    });
    const method = request.method ?? "";
    const path = (request.url ?? "").split("?", 1)[0] ?? "";
    const log = (words: string) => stamped(`#${n} ${method} ${path} ${words}`);

    let body: Buffer;
    try {
      body = await wholeBody(request);
    } catch {
      log("the caller left before its request was whole; nothing was forwarded");
      return;
    }

    let answer: Answer;
    try {
      answer = await forward(rule.upstream, basePath, request, body);
    } catch (error) {
      const code = codeOf(error);
      log(`no whole answer from the upstream (${code}); answered 502, not counted`);
      if (!callerGone) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        response.end(`The cut proxy got no whole answer from ${upstreamName}: ${code}.\n`);
      }
      return;
    }

    const order = orderOf(answer);
    const facts = `${answer.status}, ${answer.body.length} bytes${order === null ? "" : `, order ${order}`}`;
    const matched = counted < rule.nth && method === rule.method && pattern.test(path);
    const stillArmed = "not counted, the rule is still armed";

    if (callerGone) {
      log(
        `${facts}: the caller had left before the answer was whole, so nothing was sent${matched ? `; ${stillArmed}` : ""}`,
      );
      return;
    }
    if (!matched) {
      passThrough(response, answer);
      log(`${facts}: passed through`);
      return;
    }
    if (answer.status < 200 || answer.status > 299) {
      passThrough(response, answer);
      log(
        `${facts}: matched, but a ${answer.status} is not a commitment; passed through, ${stillArmed}`,
      );
      return;
    }
    if (rule.phase === "mid-body" && answer.body.length < 2) {
      passThrough(response, answer);
      log(
        `${facts}: matched, but an answer under 2 bytes has no middle to cut; passed through, ${stillArmed}`,
      );
      return;
    }
    counted += 1;
    if (counted < rule.nth) {
      passThrough(response, answer);
      log(`${facts}: matched, ${counted} of ${rule.nth}; passed through`);
      return;
    }
    const sent = await cut(response, answer, rule.phase);
    log(
      rule.phase === "before-headers"
        ? `${facts}: matched, ${counted} of ${rule.nth}; CUT before-headers, nothing sent, connection closed`
        : `${facts}: matched, ${counted} of ${rule.nth}; CUT mid-body, sent the status, the headers and ${sent} of ${answer.body.length} body bytes, then closed the connection`,
    );
    stamped("the rule is spent: everything passes through from here on; a restart arms it again");
  };

  const server = createServer((request, response) => {
    sequence += 1;
    const n = sequence;
    exchange(n, request, response).catch((error: unknown) => {
      stamped(`#${n} failed inside the proxy (${codeOf(error)}); the connection was closed`);
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
    `cut proxy on http://127.0.0.1:${bound}, forwarding to ${upstreamName}; it cuts matching 2xx answer number ${rule.nth} to ${rule.method} ${rule.path} ${rule.phase === "before-headers" ? "before its headers (before-headers)" : "midway through its body (mid-body)"}, once; answers that are not 2xx pass and are not counted`,
  );

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
