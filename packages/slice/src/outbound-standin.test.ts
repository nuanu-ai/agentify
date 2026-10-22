/**
 * The stand-in's promises to the organiser of a run: what each mode does to a
 * request the dashboard sends, that Coinbase's side reaches Coinbase only when
 * it passes and then unchanged, that every Coinbase request is in the record
 * from the moment it arrives, and that restoring gives back both services.
 * Coinbase is played by a loopback server here.
 */

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CoinbaseRequest,
  type MailPost,
  type StandIn,
  type StandInState,
  startStandIn,
} from "./outbound-standin.js";

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

const RATES = gzipSync(JSON.stringify({ data: { currency: "USD", rates: { IDR: "16650.5" } } }));

const running: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((one) => one.close()));
});

const coinbase = async (): Promise<{ url: URL; received: Received[] }> => {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    received.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
    });
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    response.end(RATES);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running.push({
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
  return {
    url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    received,
  };
};

const standIn = async (upstream: URL): Promise<StandIn> => {
  const started = await startStandIn({
    coinbaseUpstream: upstream,
    coinbasePort: 0,
    mailPort: 0,
    controlPort: 0,
    host: "127.0.0.1",
    say: () => undefined,
  });
  running.push(started);
  return started;
};

const at = (port: number, path: string): string => `http://127.0.0.1:${port}${path}`;

const set = async (stand: StandIn, path: string): Promise<StandInState> =>
  (await (await fetch(at(stand.controlPort, path), { method: "POST" })).json()) as StandInState;

const coinbaseRecord = async (stand: StandIn): Promise<CoinbaseRequest[]> =>
  (await (await fetch(at(stand.controlPort, "/coinbase"))).json()) as CoinbaseRequest[];

const mailRecord = async (stand: StandIn): Promise<MailPost[]> =>
  (await (await fetch(at(stand.controlPort, "/mail"))).json()) as MailPost[];

const RATES_PATH = "/v2/exchange-rates?currency=USD";

/** The dashboard's read, as it reaches the stand-in from the TLS front. */
const askRates = async (stand: StandIn, withinMs = 2_000): Promise<Response> =>
  await fetch(at(stand.coinbasePort, RATES_PATH), {
    headers: {
      accept: "application/json",
      "accept-encoding": "gzip",
      "x-forwarded-for": "172.18.0.5",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "api.coinbase.com",
    },
    signal: AbortSignal.timeout(withinMs),
  });

const MESSAGE = {
  from: "Agentify <no-reply@localhost>",
  to: ["owner@example.com"],
  subject: "A rate was saved for your shop",
  text: "Rp 16.650 to one US dollar.\nhttps://agentify.localhost/dashboard/integrations/woocommerce",
  html: "<p>Rp 16.650 to one US dollar.</p>",
};

/** The dashboard's post to its provider, as `mail.ts` makes it. */
const sendMail = async (stand: StandIn, withinMs = 2_000): Promise<Response> =>
  await fetch(at(stand.mailPort, "/emails"), {
    method: "POST",
    headers: { authorization: "Bearer anything", "content-type": "application/json" },
    body: JSON.stringify(MESSAGE),
    signal: AbortSignal.timeout(withinMs),
  });

const settled = async (read: () => Promise<{ outcome: string | null }[]>): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
    if ((await read()).every((one) => one.outcome !== null)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("Coinbase's side of the stand-in", () => {
  it("passes a request to Coinbase as the dashboard sent it and hands back Coinbase's answer byte for byte", async () => {
    const upstream = await coinbase();
    const stand = await standIn(upstream.url);

    const answer = await askRates(stand);

    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-encoding")).toBe("gzip");
    expect(await answer.json()).toEqual({
      data: { currency: "USD", rates: { IDR: "16650.5" } },
    });
    expect(upstream.received).toHaveLength(1);
    const [sent] = upstream.received;
    expect(sent?.method).toBe("GET");
    expect(sent?.url).toBe(RATES_PATH);
    expect(sent?.headers.accept).toBe("application/json");
    expect(sent?.headers["accept-encoding"]).toBe("gzip");
    expect(sent?.headers.host).toBe(upstream.url.host);
    expect(sent?.headers["x-forwarded-for"]).toBeUndefined();
    expect(sent?.headers["x-forwarded-proto"]).toBeUndefined();
  });

  it("refuses with a 503 and sends Coinbase nothing", async () => {
    const upstream = await coinbase();
    const stand = await standIn(upstream.url);
    await set(stand, "/coinbase/refuse");

    const answer = await askRates(stand);

    expect(answer.status).toBe(503);
    expect(upstream.received).toHaveLength(0);
  });

  it("answers nothing while silent, sends Coinbase nothing, and records that the caller gave up", async () => {
    const upstream = await coinbase();
    const stand = await standIn(upstream.url);
    await set(stand, "/coinbase/silent");

    await expect(askRates(stand, 300)).rejects.toThrow();
    await settled(() => coinbaseRecord(stand));

    expect(upstream.received).toHaveLength(0);
    const [line] = await coinbaseRecord(stand);
    expect(line?.mode).toBe("silent");
    expect(line?.outcome).toBe("the caller left without an answer");
    expect(line?.ms).toBeGreaterThanOrEqual(250);
  });

  it("records a request from the moment it arrives, while it is still unanswered", async () => {
    const stand = await standIn((await coinbase()).url);
    await set(stand, "/coinbase/silent");
    const before = Date.now();

    const waiting = askRates(stand, 1_000).catch(() => null);
    let record: CoinbaseRequest[] = [];
    for (let tries = 0; tries < 50 && record.length === 0; tries += 1) {
      record = await coinbaseRecord(stand);
      if (record.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(record).toHaveLength(1);
    expect(record[0]?.outcome).toBeNull();
    expect(record[0]?.path).toBe(RATES_PATH);
    expect(Date.parse(record[0]?.at ?? "")).toBeGreaterThanOrEqual(before - 5);
    await waiting;
  });

  it("records every request in order with the mode it met, and restore makes it pass again", async () => {
    const upstream = await coinbase();
    const stand = await standIn(upstream.url);

    await askRates(stand);
    await set(stand, "/coinbase/refuse");
    await askRates(stand);
    const restored = await set(stand, "/restore");
    await askRates(stand);
    await settled(() => coinbaseRecord(stand));

    expect(restored.coinbase).toBe("pass");
    expect(upstream.received).toHaveLength(2);
    const record = await coinbaseRecord(stand);
    expect(record.map((one) => [one.seq, one.mode, one.outcome])).toEqual([
      [1, "pass", "passed, Coinbase answered 200"],
      [2, "refuse", "refused with 503"],
      [3, "pass", "passed, Coinbase answered 200"],
    ]);
  });

  it("refuses a mode it does not have and keeps the one in force", async () => {
    const stand = await standIn((await coinbase()).url);

    const answer = await fetch(at(stand.controlPort, "/coinbase/drop"), { method: "POST" });

    expect(answer.status).toBe(400);
    expect(
      ((await (await fetch(at(stand.controlPort, "/status"))).json()) as StandInState).coinbase,
    ).toBe("pass");
  });
});

describe("the mail side of the stand-in", () => {
  it("accepts a message with a 200 the dashboard reads as taken, and keeps it to be read", async () => {
    const stand = await standIn((await coinbase()).url);

    const answer = await sendMail(stand);
    await settled(() => mailRecord(stand));

    expect(answer.status).toBe(200);
    const [kept] = await mailRecord(stand);
    expect(kept?.outcome).toBe("accepted and kept here");
    expect(kept?.to).toEqual(MESSAGE.to);
    expect(kept?.subject).toBe(MESSAGE.subject);
    expect(kept?.text).toBe(MESSAGE.text);
  });

  it("refuses a message with a status the dashboard reads as a refusal", async () => {
    const stand = await standIn((await coinbase()).url);
    await set(stand, "/mail/refuse");

    const answer = await sendMail(stand);
    await settled(() => mailRecord(stand));

    expect(answer.ok).toBe(false);
    expect((await mailRecord(stand))[0]?.outcome).toBe("refused with 503");
  });

  it("answers nothing while silent until the dashboard gives up, and restore accepts again", async () => {
    const stand = await standIn((await coinbase()).url);
    await set(stand, "/mail/silent");

    await expect(sendMail(stand, 300)).rejects.toThrow();
    await settled(() => mailRecord(stand));
    await set(stand, "/restore");
    const after = await sendMail(stand);

    expect((await mailRecord(stand))[0]?.outcome).toBe("the caller left without an answer");
    expect(after.status).toBe(200);
  });
});
