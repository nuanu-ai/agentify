/**
 * The mock merchant, pointed at a gateway that is already running: the same
 * cards, price desk and goods as the offline suite, opening its subscription
 * against a live gateway over the network instead of one booted in its own
 * process. `merchant.ts` holds the handlers; this file wires them to an
 * address, keeps the process alive and writes down whether the subscription is
 * still getting through (see `SUBSCRIPTION_FILE` for what that can claim). It
 * gives the local stack a catalogue and somewhere for an order to go;
 * `pnpm test` never runs it.
 *
 * One part is a stand-in. Nobody here makes the asynchronous card's explicit
 * deliver call, so this file waits a few seconds and makes it itself, in place
 * of the provider issuing an eSIM profile.
 *
 *   GATEWAY_URL=http://localhost:8080 MERCHANT_API_KEY=… pnpm --filter @agentify/slice serve
 */

import { renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMerchant } from "./merchant.js";
import {
  DOUBT_MS,
  NOTHING_HAS_GONE_WRONG,
  readProblems,
  subscriptionLine,
  type WhatIsKnown,
} from "./subscription.js";

const baseUrl = process.env.GATEWAY_URL ?? "http://localhost:8080";
const apiKey = process.env.MERCHANT_API_KEY;

if (apiKey === undefined || apiKey === "") {
  console.error(
    "[merchant] MERCHANT_API_KEY is not set — it is the key this merchant opens its subscription with, and there is no default for it",
  );
  process.exit(1);
}

/** How long the eSIM's provider is pretended to take. */
const PROVISIONING_MS = 4_000;

/** How often the accepted orders are looked over. */
const SWEEP_MS = 500;

/**
 * Where this process writes what it can say about its own subscription.
 *
 * The merchant has no port and nothing to ask it, so `docker compose ps` alone
 * says `running` whether it is selling or its worker ended on the first poll.
 * The healthcheck compose.yaml gives this service reads this file: the line
 * says whether the subscription is believed to be getting through, and the
 * file's modification time says the loop that wrote it is still turning. Either
 * can be true while the other is not, so both are checked.
 *
 * "Getting through" means only that no poll failure has been reported for
 * DOUBT_MS; `subscription.ts` holds that reasoning. It is late at both ends, so
 * a gateway restarted on purpose shows this container red for about ninety
 * seconds. It says nothing about whether the catalogue is still published or a
 * paid order would be routed here: a database emptied under a live subscription
 * leaves the line reading `selling`.
 *
 * The name is written out again in compose.yaml. Both sides ask the runtime for
 * the directory rather than spelling it, so a TMPDIR set on the service moves
 * the two together.
 */
const SUBSCRIPTION_FILE = join(tmpdir(), "agentify-merchant-subscription");

/**
 * Where the line is written before it is moved into place.
 *
 * A reader on the other side of this is a healthcheck that runs whenever it
 * likes, and a plain write truncates first: there is a moment in every one of
 * them where the file exists and is empty, and a probe that lands in it reads
 * no verdict at all. Writing beside it and renaming makes the swap atomic, so
 * the reader sees either the old line or the new one and never the gap between
 * them. Same directory, or the rename stops being a rename.
 */
const SUBSCRIPTION_FILE_BEING_WRITTEN = `${SUBSCRIPTION_FILE}.writing`;

const merchant = startMerchant(baseUrl, apiKey);

const firstSeen = new Map<string, number>();
const delivered = new Set<string>();

/**
 * Delivers what has been taken on and has waited long enough.
 *
 * `deliverAccepted` does not forget an order once it has delivered it, so the
 * set here is what stops a second delivery — which the gateway would answer
 * honestly, but which would be this file's own defect rather than the
 * at-least-once behaviour the merchant is meant to demonstrate.
 */
const sweep = (): void => {
  const now = Date.now();
  for (const orderId of merchant.acceptedOrders.keys()) {
    if (delivered.has(orderId)) {
      continue;
    }
    const seen = firstSeen.get(orderId);
    if (seen === undefined) {
      firstSeen.set(orderId, now);
      console.log(`[merchant] took on ${orderId}, issuing in ${PROVISIONING_MS / 1_000}s`);
      continue;
    }
    if (now - seen < PROVISIONING_MS) {
      continue;
    }
    delivered.add(orderId);
    merchant
      .deliverAccepted(orderId)
      .then((answer) => {
        console.log(`[merchant] delivered ${orderId}: ${JSON.stringify(answer)}`);
      })
      .catch((thrown: unknown) => {
        // Not fatal to the process: one order that would not deliver leaves the
        // merchant selling, and the gateway will hold it to its deadline.
        console.error(`[merchant] could not deliver ${orderId}:`, thrown);
      });
  }
};

/** What the SDK's reports have added up to. `subscription.ts` does the adding. */
let known: WhatIsKnown = NOTHING_HAS_GONE_WRONG;

/** Whether the last attempt to write the file failed, so it is said once. */
let writingFailed = false;

/** Reads what the SDK could not get through, and writes down what follows. */
const sayWhatIsKnown = (): void => {
  const now = Date.now();
  const reading = readProblems(merchant.problems, known, now);
  known = reading.known;

  for (const announcement of reading.announce) {
    if (announcement.said === "over") {
      console.error(`[merchant] the subscription is over and will not resume: ${announcement.why}`);
    } else if (announcement.said === "not_getting_through") {
      console.error(`[merchant] not getting through to ${baseUrl}: ${announcement.why}`);
    } else {
      console.log(
        `[merchant] no poll has failed for ${DOUBT_MS / 1_000}s, so ${baseUrl} is taken to be answering again`,
      );
    }
  }

  try {
    writeFileSync(SUBSCRIPTION_FILE_BEING_WRITTEN, `${subscriptionLine(known, baseUrl, now)}\n`);
    renameSync(SUBSCRIPTION_FILE_BEING_WRITTEN, SUBSCRIPTION_FILE);
    writingFailed = false;
  } catch (thrown) {
    // Not fatal and not silent. A file that stops being written goes stale, and
    // stale is what the healthcheck reads as a process no longer saying
    // anything — which is the truth here. What must not happen is a merchant
    // that stopped selling because its status file would not write.
    if (!writingFailed) {
      writingFailed = true;
      console.error(`[merchant] cannot write ${SUBSCRIPTION_FILE}, so it goes stale:`, thrown);
    }
  }
};

await merchant.start();
await merchant.publishCatalog();
console.log(`[merchant] subscribed to ${baseUrl}, two cards published`);
// Written now rather than at the first tick, so the file exists from the same
// moment the line above is printed. What it says at this point rests on the
// publish: the gateway was reached and it took both cards under this key.
sayWhatIsKnown();

const sweeping = setInterval(() => {
  sweep();
  sayWhatIsKnown();
}, SWEEP_MS);

const shutDown = async (signal: string): Promise<void> => {
  console.log(`[merchant] ${signal}: stopping`);
  clearInterval(sweeping);
  // So that the file left behind says the process went on purpose, rather than
  // reading as a heartbeat that froze.
  known = { ...known, stoppedBecause: signal };
  sayWhatIsKnown();
  await merchant.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutDown("SIGTERM"));
process.on("SIGINT", () => void shutDown("SIGINT"));
