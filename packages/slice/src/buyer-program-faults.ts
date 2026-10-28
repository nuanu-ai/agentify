/**
 * Loaded with `--import` into the process that runs the quickstart's buyer
 * program, so a test can drive it without changing the program itself.
 *
 * It refuses every address that is not on this machine, so the program cannot
 * reach the real test channel from `pnpm test`.
 *
 * It plays the faults named in `BUYER_FAULTS`, a JSON object:
 * `challengeNetwork` with `challengeAsset` move a payment request onto another
 * chain and that chain's token.
 *
 * And it makes the program's waits between reads of an order take a
 * millisecond, or the `waitMs` the faults name, by handing the program, and
 * only the program, its own `node:timers/promises`. Every other timer in the
 * process, the HTTP client's included, keeps real time.
 */

import { registerHooks } from "node:module";

interface Faults {
  readonly challengeNetwork?: string;
  readonly challengeAsset?: string;
  readonly waitMs?: number;
}

const faults = JSON.parse(process.env.BUYER_FAULTS ?? "{}") as Faults;

const PROGRAM = /\/buyer\.mts$/;

const QUICK_WAITS = `data:text/javascript,${encodeURIComponent(
  `export const setTimeout = (_ms, value) => new Promise((done) => globalThis.setTimeout(() => done(value), ${faults.waitMs ?? 1}));`,
)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:timers/promises" && PROGRAM.test(context.parentURL ?? "")) {
      return { url: QUICK_WAITS, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

/** A payment request with every requirement moved onto another chain and its token. */
const onAnotherChain = (header: string, network: string, asset: string): string => {
  const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepts: { network: string; asset: string }[];
  };
  for (const requirement of challenge.accepts) {
    requirement.network = network;
    requirement.asset = asset;
  }
  return Buffer.from(JSON.stringify(challenge)).toString("base64");
};

const reachable = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== "127.0.0.1") {
    throw new TypeError(`fetch failed: ${url.origin} is not on this machine`);
  }

  const answer = await reachable(request);
  const challenge = answer.headers.get("payment-required");
  const { challengeNetwork, challengeAsset } = faults;
  if (challenge === null || challengeNetwork === undefined || challengeAsset === undefined) {
    return answer;
  }
  const headers = new Headers(answer.headers);
  headers.set("payment-required", onAnotherChain(challenge, challengeNetwork, challengeAsset));
  return new Response(await answer.text(), { status: answer.status, headers });
};
