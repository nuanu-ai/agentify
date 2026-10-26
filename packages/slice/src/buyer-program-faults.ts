/**
 * Loaded with `--import` into the process that runs the quickstart's buyer
 * program, so the program can meet a broken network without a line of it
 * changing. It does three things and nothing else.
 *
 * It refuses every address that is not on this machine, so the program cannot
 * reach the real test channel from `pnpm test`.
 *
 * It plays the faults named in `BUYER_FAULTS`, a JSON object:
 * `statusReads`, the HTTP statuses the first reads of an order answer with
 * instead of reaching the gateway; `losePaidAnswer`, which lets a paid purchase
 * reach the gateway and then drops its answer as a broken connection would;
 * and `challengeNetwork`, which rewrites the chain a payment request names.
 *
 * And it makes the program's waits between reads take a millisecond, by
 * handing the program, and only the program, its own `node:timers/promises`.
 * Every other timer in the process, the HTTP client's included, keeps real
 * time.
 */

import { registerHooks } from "node:module";

interface Faults {
  readonly statusReads?: readonly number[];
  readonly losePaidAnswer?: boolean;
  readonly challengeNetwork?: string;
}

const faults = JSON.parse(process.env.BUYER_FAULTS ?? "{}") as Faults;

const PROGRAM = /\/buyer\.mts$/;

const QUICK_WAITS = `data:text/javascript,${encodeURIComponent(
  "export const setTimeout = (_ms, value) => new Promise((done) => globalThis.setTimeout(() => done(value), 1));",
)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:timers/promises" && PROGRAM.test(context.parentURL ?? "")) {
      return { url: QUICK_WAITS, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const unavailable = (status: number): Response =>
  new Response(
    JSON.stringify({
      error: {
        code: "unavailable",
        message: "The service is unavailable for a moment.",
        retryable: true,
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );

/** A payment request with every requirement moved onto another chain. */
const onAnotherChain = (header: string, network: string): string => {
  const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepts: { network: string }[];
  };
  for (const requirement of challenge.accepts) requirement.network = network;
  return Buffer.from(JSON.stringify(challenge)).toString("base64");
};

const reachable = globalThis.fetch;
const failedReads = [...(faults.statusReads ?? [])];

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname !== "127.0.0.1") {
    throw new TypeError(`fetch failed: ${url.origin} is not on this machine`);
  }

  const reading = (init?.method ?? "GET") === "GET" && url.pathname.startsWith("/x402/orders/");
  const failed = reading ? failedReads.shift() : undefined;
  if (failed !== undefined) return unavailable(failed);

  const answer = await reachable(input, init);
  const paid = new Headers(init?.headers).has("payment-signature");
  if (paid && faults.losePaidAnswer === true) {
    await answer.body?.cancel();
    throw new TypeError("fetch failed: the connection closed before the answer arrived");
  }

  const challenge = answer.headers.get("payment-required");
  if (challenge === null || faults.challengeNetwork === undefined) return answer;
  const headers = new Headers(answer.headers);
  headers.set("payment-required", onAnotherChain(challenge, faults.challengeNetwork));
  return new Response(await answer.text(), { status: answer.status, headers });
};
