/**
 * Asking the cabinet to tell a merchant of a change, over a real socket.
 *
 * The promise this adapter keeps is the fourth outcome. A cabinet that took
 * every message answers so, and so does one that had nobody to tell or could
 * not hand a message over; everything else — a status that is not an answer,
 * a body that is not one, a cabinet that is not there, one slower than the
 * deadline — is `unconfirmed`, because a message may have gone out and nothing
 * here can say it did not. A wallet change recorded on the strength of a guess
 * in either direction is the failure ADR-0019 is written against.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Announcement, GATEWAY_ROUTE_PATH } from "../../announcements.js";
import { CabinetAnnouncer } from "./announcer.js";

const SECRET = "the-gateway-cabinet-secret-this-suite-presents";

const ANNOUNCEMENT: Announcement = {
  kind: "wallet_change",
  merchant_id: "mch_1",
  from: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  to: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  not_before: "2026-09-26T12:00:00.000Z",
  asked_with: { kind: "cabinet" },
};

interface Arrived {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

let running: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (running === null) return resolve();
    running.closeAllConnections();
    running.close(() => resolve());
  });
  running = null;
});

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? null : JSON.parse(text);
};

/** A cabinet that answers every request the same way, and remembers what came. */
const aCabinet = async (
  status: number,
  body: string,
  delayMs = 0,
): Promise<{ url: string; arrived: Arrived[] }> => {
  const arrived: Arrived[] = [];
  running = createServer(async (request, response) => {
    arrived.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: await readBody(request),
    });
    setTimeout(() => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    }, delayMs);
  });
  running.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => running?.once("listening", resolve));
  const { port } = running.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, arrived };
};

describe("asking the cabinet", () => {
  it("sends the announcement to its route, with the secret, and reads its answer", async () => {
    const { url, arrived } = await aCabinet(200, JSON.stringify({ outcome: "handed_over" }));

    const outcome = await new CabinetAnnouncer({ url, secret: SECRET }).announce(ANNOUNCEMENT);

    expect(outcome).toBe("handed_over");
    expect(arrived).toStrictEqual([
      {
        method: "POST",
        path: GATEWAY_ROUTE_PATH,
        authorization: `Bearer ${SECRET}`,
        body: { operation: "announce", ...ANNOUNCEMENT },
      },
    ]);
  });

  it.each(["nobody_to_tell", "not_handed_over"] as const)(
    "passes on the cabinet's own %s",
    async (said) => {
      const { url } = await aCabinet(200, JSON.stringify({ outcome: said }));

      expect(await new CabinetAnnouncer({ url, secret: SECRET }).announce(ANNOUNCEMENT)).toBe(said);
    },
  );
});

describe("a cabinet that turned the request away", () => {
  // Its listener answers these before it reads an announcement or tells
  // anybody, so nothing was sent — which is a different fact from a cabinet
  // that did not answer, and the refusal a merchant reads depends on it.
  it.each([
    ["the wrong secret", 401],
    ["a body it would not read", 400],
    ["a body too large", 413],
    ["an address it does not answer on", 404],
  ])("reads %s as refused, with nothing sent", async (_what, status) => {
    const { url } = await aCabinet(status, "");

    expect(await new CabinetAnnouncer({ url, secret: SECRET }).announce(ANNOUNCEMENT)).toBe(
      "refused_by_cabinet",
    );
  });

  it("says in the log that the two halves hold different secrets, without either", async () => {
    const { url } = await aCabinet(401, "");
    const said: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...parts) => {
      said.push(parts.map(String).join(" "));
    });
    try {
      await new CabinetAnnouncer({ url, secret: SECRET }).announce(ANNOUNCEMENT);
    } finally {
      error.mockRestore();
    }

    expect(said.join("\n")).toContain("GATEWAY_CABINET_SECRET");
    expect(said.join("\n")).not.toContain(SECRET);
  });
});

describe("a cabinet that did not answer", () => {
  it.each([
    ["a failure", 500, JSON.stringify({ outcome: "handed_over" })],
    ["a body that is not an answer", 200, JSON.stringify({ outcome: "sent" })],
    ["a body that is not JSON", 200, "<html>"],
  ])("is unconfirmed when it sends %s", async (_what, status, body) => {
    const { url } = await aCabinet(status, body);

    expect(await new CabinetAnnouncer({ url, secret: SECRET }).announce(ANNOUNCEMENT)).toBe(
      "unconfirmed",
    );
  });

  it("is unconfirmed when nothing listens where it is asked", async () => {
    const { url } = await aCabinet(200, "{}");
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = null;

    expect(await new CabinetAnnouncer({ url, secret: SECRET }).announce(ANNOUNCEMENT)).toBe(
      "unconfirmed",
    );
  });

  it("is unconfirmed when it answers after the deadline, however it answers", async () => {
    const { url } = await aCabinet(200, JSON.stringify({ outcome: "handed_over" }), 200);

    expect(await new CabinetAnnouncer({ url, secret: SECRET }, 50).announce(ANNOUNCEMENT)).toBe(
      "unconfirmed",
    );
  });
});
