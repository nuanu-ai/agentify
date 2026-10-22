/**
 * The stand-in for the two outside services the dashboard calls on a merchant's
 * behalf: Coinbase's exchange rates and the mail provider.
 *
 * It listens on three ports inside its container. The Coinbase port receives,
 * in plain http, what the TLS front of `packages/slice/outbound` decrypted from
 * the application's requests to api.coinbase.com; the mail port is the
 * provider the application's `MAIL_URL` names; the control port takes a
 * tester's commands and hands out the record. Each side has a mode, and a
 * mode applies to every request that arrives after it is set.
 *
 * The record of a Coinbase request is made when the request arrives, before
 * anything is decided about it, so a request is in the record however it ends.
 * Mail is never forwarded anywhere: an accepted message is kept here and goes
 * no further.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";

export const COINBASE_MODES = ["pass", "refuse", "silent"] as const;
type CoinbaseMode = (typeof COINBASE_MODES)[number];

export const MAIL_MODES = ["accept", "refuse", "silent"] as const;
type MailMode = (typeof MAIL_MODES)[number];

/** One request the application sent to api.coinbase.com. */
export interface CoinbaseRequest {
  readonly seq: number;
  /** When the request arrived, before anything was done with it. */
  readonly at: string;
  readonly method: string;
  /** The path with its query string; this host's queries name a currency and nothing else. */
  readonly path: string;
  /** The mode in force when the request arrived. */
  readonly mode: CoinbaseMode;
  /** What became of it, or null while it is still open. */
  outcome: string | null;
  /** How long it was open, or null while it is still open. */
  ms: number | null;
}

/** One post the application made to the mail provider. */
export interface MailPost {
  readonly seq: number;
  readonly at: string;
  readonly mode: MailMode;
  outcome: string | null;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly subject: string | null;
  /** The plain-text body, which carries every link the message does. */
  readonly text: string | null;
}

export interface StandInState {
  readonly coinbase: CoinbaseMode;
  readonly mail: MailMode;
  readonly coinbaseRequests: number;
  readonly mailPosts: number;
}

export interface StandIn {
  readonly coinbasePort: number;
  readonly mailPort: number;
  readonly controlPort: number;
  close(): Promise<void>;
}

export interface StandInOptions {
  /** Where a request goes when Coinbase's side passes: Coinbase itself, or a loopback server in a test. */
  readonly coinbaseUpstream: URL;
  readonly coinbasePort: number;
  readonly mailPort: number;
  readonly controlPort: number;
  /** Where the three ports listen: every interface in the container, loopback in a test. */
  readonly host: string;
  /** One line per request as it ends, for the container's log. */
  readonly say: (line: string) => void;
}

/**
 * Headers that describe one connection rather than the request, and those the
 * TLS front adds on its way in. Neither is part of what the application sent.
 */
const NOT_FORWARDED = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "via",
]);

const forwardable = (headers: IncomingHttpHeaders, host: string): OutgoingHttpHeaders => {
  const kept: OutgoingHttpHeaders = { host };
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !NOT_FORWARDED.has(name)) kept[name] = value;
  }
  return kept;
};

const answerable = (headers: IncomingHttpHeaders): OutgoingHttpHeaders => {
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !NOT_FORWARDED.has(name)) kept[name] = value;
  }
  return kept;
};

const listen = async (server: Server, port: number, host: string): Promise<number> =>
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

const closed = async (server: Server): Promise<void> =>
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

const readBody = async (request: IncomingMessage, limit: number): Promise<Buffer | null> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = chunk as Buffer;
    size += piece.length;
    if (size > limit) return null;
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
};

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
};

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

const addressesOf = (value: unknown): readonly string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((one): one is string => typeof one === "string");
  return [];
};

/** Enough for any message the dashboard writes, and a ceiling on what a stray post can make it hold. */
const LARGEST_MESSAGE = 1_000_000;

export const describeCoinbase = (one: CoinbaseRequest): string =>
  `${one.at}  #${one.seq}  ${one.method} ${one.path}  ${one.mode}  ${
    one.outcome === null ? "still open" : `${one.outcome} after ${one.ms} ms`
  }`;

export const describeMail = (one: MailPost): string =>
  `${one.at}  #${one.seq}  ${one.mode}  ${one.outcome ?? "still open"}  to ${
    one.to.length === 0 ? "nobody named" : one.to.join(", ")
  }: ${one.subject ?? "(no subject)"}`;

export async function startStandIn(options: StandInOptions): Promise<StandIn> {
  let coinbaseMode: CoinbaseMode = "pass";
  let mailMode: MailMode = "accept";
  const coinbaseRecord: CoinbaseRequest[] = [];
  const mailRecord: MailPost[] = [];
  const upstreamHost = options.coinbaseUpstream.host;
  const send = options.coinbaseUpstream.protocol === "https:" ? httpsRequest : httpRequest;

  const coinbase = createServer((request, response) => {
    const opened = Date.now();
    const line: CoinbaseRequest = {
      seq: coinbaseRecord.length + 1,
      at: new Date(opened).toISOString(),
      method: request.method ?? "GET",
      path: request.url ?? "/",
      mode: coinbaseMode,
      outcome: null,
      ms: null,
    };
    coinbaseRecord.push(line);
    const end = (outcome: string): void => {
      if (line.outcome !== null) return;
      line.outcome = outcome;
      line.ms = Date.now() - opened;
      options.say(`coinbase ${describeCoinbase(line)}`);
    };
    // Whichever way a request ends, the caller leaving first is what its line says.
    response.on("close", () => {
      if (!response.writableFinished) end("the caller left without an answer");
    });

    if (line.mode === "refuse") {
      response.on("finish", () => end("refused with 503"));
      json(response, 503, { error: "refused by the outbound stand-in" });
      return;
    }
    if (line.mode === "silent") {
      // Nothing is written and nothing is read: the request stays open until
      // its caller gives up.
      return;
    }

    const target = new URL(line.path, options.coinbaseUpstream);
    const outgoing = send(
      target,
      { method: line.method, headers: forwardable(request.headers, upstreamHost) },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answerable(answer.headers));
        answer.pipe(response);
        response.on("finish", () => end(`passed, Coinbase answered ${answer.statusCode}`));
      },
    );
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      // A pass that could not reach Coinbase is not a fault this stand-in made,
      // and the line says so in the network's own words.
      if (!response.headersSent) {
        response.on("finish", () =>
          end(`passed, Coinbase could not be reached (${error.code ?? "no code"})`),
        );
        json(response, 502, { error: "Coinbase could not be reached from the stand-in" });
      } else {
        response.destroy();
      }
    });
    request.pipe(outgoing);
  });

  const mail = createServer((request, response) => {
    void (async () => {
      const at = new Date().toISOString();
      const mode = mailMode;
      const body = await readBody(request, LARGEST_MESSAGE);
      let parsed: Record<string, unknown> = {};
      try {
        const value: unknown = body === null ? null : JSON.parse(body.toString("utf8"));
        if (typeof value === "object" && value !== null) parsed = value as Record<string, unknown>;
      } catch {
        // Kept as a post with nothing readable in it.
      }
      const post: MailPost = {
        seq: mailRecord.length + 1,
        at,
        mode,
        outcome: null,
        from: stringOrNull(parsed.from),
        to: addressesOf(parsed.to),
        subject: stringOrNull(parsed.subject),
        text: stringOrNull(parsed.text),
      };
      mailRecord.push(post);
      const end = (outcome: string): void => {
        if (post.outcome !== null) return;
        post.outcome = outcome;
        options.say(`mail ${describeMail(post)}`);
      };
      response.on("close", () => {
        if (!response.writableFinished) end("the caller left without an answer");
      });

      if (request.method !== "POST" || request.url !== "/emails") {
        response.on("finish", () => end(`not a send (${request.method} ${request.url}), 404`));
        json(response, 404, { error: "the stand-in takes POST /emails and nothing else" });
        return;
      }
      if (mode === "silent") return;
      if (mode === "refuse") {
        response.on("finish", () => end("refused with 503"));
        json(response, 503, { error: "refused by the outbound stand-in" });
        return;
      }
      response.on("finish", () => end("accepted and kept here"));
      json(response, 200, { id: `outbound-stand-in-${post.seq}` });
    })();
  });

  const state = (): StandInState => ({
    coinbase: coinbaseMode,
    mail: mailMode,
    coinbaseRequests: coinbaseRecord.length,
    mailPosts: mailRecord.length,
  });

  const control = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://control").pathname;
    const [, side, word] = path.split("/");
    if (request.method === "GET" && path === "/status") return json(response, 200, state());
    if (request.method === "GET" && path === "/coinbase")
      return json(response, 200, coinbaseRecord);
    if (request.method === "GET" && path === "/mail") return json(response, 200, mailRecord);
    if (request.method === "POST" && path === "/restore") {
      coinbaseMode = "pass";
      mailMode = "accept";
      options.say("control: restored, Coinbase passes and mail is accepted");
      return json(response, 200, state());
    }
    if (request.method === "POST" && side === "coinbase" && word !== undefined) {
      if (!(COINBASE_MODES as readonly string[]).includes(word)) {
        return json(response, 400, { error: `Coinbase's side takes ${COINBASE_MODES.join(", ")}` });
      }
      coinbaseMode = word as CoinbaseMode;
      options.say(`control: Coinbase ${coinbaseMode} from now on`);
      return json(response, 200, state());
    }
    if (request.method === "POST" && side === "mail" && word !== undefined) {
      if (!(MAIL_MODES as readonly string[]).includes(word)) {
        return json(response, 400, { error: `the mail side takes ${MAIL_MODES.join(", ")}` });
      }
      mailMode = word as MailMode;
      options.say(`control: mail ${mailMode} from now on`);
      return json(response, 200, state());
    }
    return json(response, 404, { error: "no such control" });
  });

  const coinbasePort = await listen(coinbase, options.coinbasePort, options.host);
  const mailPort = await listen(mail, options.mailPort, options.host);
  const controlPort = await listen(control, options.controlPort, options.host);
  return {
    coinbasePort,
    mailPort,
    controlPort,
    async close() {
      await Promise.all([closed(coinbase), closed(mail), closed(control)]);
    },
  };
}
