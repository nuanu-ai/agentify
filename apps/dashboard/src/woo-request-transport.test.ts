import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { describe, expect, it, vi } from "vitest";
import { wooRequest } from "./woo-request.js";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "153.124.160.16", family: 4 }],
}));
vi.mock("node:https", () => ({ request: vi.fn() }));

const replyFromShop = async (status: number, body = "") => {
  const opened = Promise.withResolvers<void>();
  const outgoing = Object.assign(new EventEmitter(), {
    setTimeout: () => outgoing,
    end: () => {},
  });
  vi.mocked(httpsRequest).mockImplementation(() => {
    opened.resolve();
    return outgoing as unknown as ClientRequest;
  });
  const answer = wooRequest("https://woo.nuanu.ai/wp-json");
  await opened.promise;

  return {
    answer,
    finish() {
      const incoming = Object.assign(new EventEmitter(), {
        statusCode: status,
        headers: { "content-type": "text/plain", "x-shop-response": "preserved" },
      });
      outgoing.emit("response", incoming);
      if (body !== "") incoming.emit("data", Buffer.from(body));
      incoming.emit("end");
    },
  };
};

describe("responses from the WooCommerce HTTPS transport", () => {
  it.each([204, 205, 304])("returns HTTP %s with its headers and no body", async (status) => {
    const reply = await replyFromShop(status);
    reply.finish();
    const response = await reply.answer;

    expect(response.status).toBe(status);
    expect(response.headers.get("x-shop-response")).toBe("preserved");
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("preserves the body and headers of an ordinary response", async () => {
    const reply = await replyFromShop(200, '{"products":[]}');
    reply.finish();
    const response = await reply.answer;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe('{"products":[]}');
  });

  it("rejects the request when the shop's status cannot become a Response", async () => {
    const reply = await replyFromShop(600);
    const rejected = reply.answer.catch((error: unknown) => error);
    reply.finish();
    expect(await rejected).toBeInstanceOf(RangeError);
  });
});
