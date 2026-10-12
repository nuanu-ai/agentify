/**
 * A gateway made of the route table, for the tests to talk to over a real
 * socket, with no network. Everything it knows about the surface it reads from
 * `@nuanu-ai/agentify-contracts`, so a test cannot pass against an address that
 * no longer exists.
 *
 * It is strict both ways: a request body the contract refuses gets a complaint,
 * and a scripted answer is held to the route's document before it goes out.
 * A test that needs to send something malformed says so by scripting `text`
 * instead of `body`. It is not a queue: redelivery and ordering are scripted
 * by answering differently on a later call.
 *
 * Not published: `index.ts` does not export it and its name keeps it out of
 * the test glob.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mountableRoutes,
  type RouteDefinition,
  type RouteName,
} from "@nuanu-ai/agentify-contracts";

/** One request that reached the gateway, after it was matched and read. */
export interface GatewayCall {
  readonly route: RouteName;
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** The key the caller presented, without the scheme word in front of it. */
  readonly apiKey: string | undefined;
}

/**
 * What a test wants sent back. `body` is a document, held to the route's own
 * schema before it goes out; `text` is sent untouched, to play a broken
 * gateway, a proxy's error page or a truncated answer.
 */
export interface GatewayAnswer {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
}

/** How a test answers one route, given the call and how many came before it. */
export type Responder = (
  call: GatewayCall,
  index: number,
) => GatewayAnswer | Promise<GatewayAnswer>;

export interface FakeGatewayOptions {
  /** The key the gateway accepts on the routes that are behind the merchant's door. */
  readonly apiKey: string;
  readonly routes: Partial<Record<RouteName, Responder>>;
}

export interface FakeGateway {
  /** The address to hand `createClient`. */
  readonly url: string;
  /** Every call that was matched to a route, in the order they arrived. */
  readonly calls: readonly GatewayCall[];
  callsTo(route: RouteName): GatewayCall[];
  close(): Promise<void>;
}

interface Segment {
  readonly literal?: string;
  readonly param?: string;
}

interface Mounted {
  readonly name: RouteName;
  readonly route: RouteDefinition;
  readonly segments: readonly Segment[];
}

const segmentsOf = (path: string): Segment[] =>
  path
    .split("/")
    .filter((part) => part !== "")
    .map((part) => (part.startsWith(":") ? { param: part.slice(1) } : { literal: part }));

const mounted: Mounted[] = mountableRoutes().map(([name, route]) => ({
  name,
  route,
  segments: segmentsOf(route.path),
}));

const matchPath = (
  segments: readonly Segment[],
  parts: readonly string[],
): Record<string, string> | null => {
  if (segments.length !== parts.length) return null;

  const params: Record<string, string> = {};

  for (const [index, segment] of segments.entries()) {
    const part = parts[index] ?? "";

    if (segment.param !== undefined) {
      params[segment.param] = decodeURIComponent(part);
      continue;
    }
    if (segment.literal !== part) return null;
  }

  return params;
};

const answersOn = (route: RouteDefinition, method: string): boolean =>
  route.method === method || (route.also_answers_on ?? []).some((other) => other === method);

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const send = (response: ServerResponse, status: number, text: string): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
};

/**
 * Refuses a call, having first read whatever it was carrying. A response ended
 * while the body is still arriving leaves it in the socket, and the next call
 * on that connection would read it as its own.
 */
const complain = async (
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  message: string,
): Promise<void> => {
  await readBody(request);
  send(response, status, JSON.stringify({ fake_gateway_refused: message }));
};

/**
 * The findings of a schema as one line, for the complaints this double sends
 * back. They are read by a person debugging a test, never by the SDK.
 */
const findingsOf = (issues: readonly { path: readonly PropertyKey[]; message: string }[]): string =>
  issues
    .map((issue) => `${issue.path.map(String).join(".") || "(whole document)"}: ${issue.message}`)
    .join("; ");

export const startFakeGateway = async (options: FakeGatewayOptions): Promise<FakeGateway> => {
  const calls: GatewayCall[] = [];

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://gateway.invalid");
    const parts = url.pathname.split("/").filter((part) => part !== "");
    const method = request.method ?? "GET";

    const hit = mounted
      .map((candidate) => ({ candidate, params: matchPath(candidate.segments, parts) }))
      .find((found) => found.params !== null);

    if (hit === undefined || hit.params === null) {
      await complain(
        request,
        response,
        404,
        `no mountable route answers ${method} ${url.pathname}`,
      );
      return;
    }

    const { candidate, params } = hit;

    if (!answersOn(candidate.route, method)) {
      await complain(
        request,
        response,
        405,
        `${candidate.name} answers on ${candidate.route.method}, not ${method}`,
      );
      return;
    }

    const authorization = request.headers.authorization;
    const apiKey =
      authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : undefined;

    if (candidate.route.auth === "merchant_key" && apiKey !== options.apiKey) {
      await complain(request, response, 401, `${candidate.name} is behind the merchant's key`);
      return;
    }

    const raw = await readBody(request);
    let body: unknown;

    if (raw !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        await complain(request, response, 400, "the body was not JSON");
        return;
      }
    }

    const query = Object.fromEntries(url.searchParams);

    if (candidate.route.query !== undefined) {
      const checked = candidate.route.query.safeParse(query);
      if (!checked.success) {
        await complain(
          request,
          response,
          400,
          `the query string is not what ${candidate.name} takes: ${findingsOf(checked.error.issues)}`,
        );
        return;
      }
    }

    if (candidate.route.request !== undefined && method === candidate.route.method) {
      const checked = candidate.route.request.safeParse(body);
      if (!checked.success) {
        await complain(
          request,
          response,
          422,
          `the body is not what ${candidate.name} takes: ${findingsOf(checked.error.issues)}`,
        );
        return;
      }
    }

    const call: GatewayCall = { route: candidate.name, method, params, query, body, apiKey };
    const index = calls.filter((earlier) => earlier.route === candidate.name).length;
    calls.push(call);

    const responder = options.routes[candidate.name];

    if (responder === undefined) {
      await complain(request, response, 501, `the test did not script ${candidate.name}`);
      return;
    }

    // A caller that goes away, such as a worker abandoning its parked poll,
    // ends the exchange here too, as a real gateway drops work for a closed
    // connection; otherwise that connection could answer nothing else.
    const clientLeft = Symbol("the caller went away");
    const gone = new Promise<typeof clientLeft>((resolve) => {
      response.on("close", () => resolve(clientLeft));
    });

    const answer = await Promise.race([responder(call, index), gone]);

    if (answer === clientLeft) {
      response.destroy();
      return;
    }

    const status = answer.status ?? 200;

    if (answer.text !== undefined) {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(answer.text);
      return;
    }

    if (status >= 200 && status < 300) {
      const checked = candidate.route.response.document.safeParse(answer.body);
      if (!checked.success) {
        await complain(
          request,
          response,
          500,
          `the test scripted an answer ${candidate.name} could never send: ${findingsOf(checked.error.issues)}`,
        );
        return;
      }
    }

    send(response, status, JSON.stringify(answer.body));
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((cause: unknown) => {
      void complain(request, response, 500, `the double itself failed: ${String(cause)}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    callsTo: (route: RouteName) => calls.filter((call) => call.route === route),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};
