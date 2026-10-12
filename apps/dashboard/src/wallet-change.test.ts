/**
 * How long the settings page waits for the gateway to write the payout wallet.
 * On live the gateway answers a change only after every message about it is
 * handed to the mail provider, which takes longer than a screen waits; a page
 * that gave up sooner would tell a merchant nothing answered while their change
 * or their cancel was being recorded. The gateway's answer is held back on a
 * clock the test moves, so nobody waits for it.
 */

import { type Harness, harness } from "@agentify/gateway/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { gatewayFor, registrarFor } from "./gateway.js";
import { identityFor } from "./identity.js";
import { type PageServices, pageServicesFor } from "./page-services.js";

const PERSON = "owner@example.com";
/** Of the right shape, and obviously not a real address. */
const SHAPED = "0x0123456789abcdef0123456789abcdef01234567";
/** Past a screen's ten seconds, inside the time an announcement may take. */
const WRITTEN_AFTER_MS = 15_000;

const LIVE = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
};

/** The settings' services over a live gateway whose wallet writes are slow. */
const live = async (): Promise<{ harnessed: Harness; services: PageServices }> => {
  const harnessed = await harness({
    PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001",
    ...LIVE,
    CDP_API_KEY_ID: "key-id",
    CDP_API_KEY_SECRET: "key-secret",
  });
  const config = loadConfig({
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
    ...LIVE,
  });
  const slow = new Proxy(harnessed.gateway, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "setPayoutWallet") return value.bind(target);
      return async (...asked: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, WRITTEN_AFTER_MS));
        return await value.apply(target, asked);
      };
    },
  });
  const services = pageServicesFor(config, {
    identity: identityFor(config, { postman: async () => "accepted" }),
    clientFor: (acting, answerWithinMs) => gatewayFor(slow, acting, answerWithinMs),
    registrar: registrarFor(slow),
    woo: null,
    shopState: async () => undefined,
  });
  return { harnessed, services };
};

const owner = (harnessed: Harness) => ({
  id: "acct_1",
  email: PERSON,
  confirmed: true,
  merchant: { id: harnessed.merchant.id },
});

const waiting = async (harnessed: Harness) =>
  (await harnessed.store.merchantById(harnessed.merchant.id))?.payoutWallet.pending ?? null;

afterEach(() => {
  vi.useRealTimers();
});

describe("a press that writes the payout wallet", () => {
  it("waits for a change longer than a screen waits, since it is announced first", async () => {
    const { harnessed, services } = await live();
    const form = new FormData();
    form.set("payout_wallet", SHAPED);
    vi.useFakeTimers();

    const pressed = services.settings.wallet(owner(harnessed), form, undefined);
    await vi.advanceTimersByTimeAsync(WRITTEN_AFTER_MS);

    expect(await pressed).toStrictEqual({ kind: "redirect", location: "/settings" });
    expect((await waiting(harnessed))?.address.toLowerCase()).toBe(SHAPED);
    await harnessed.stop();
  });

  it("waits for a cancel as long, since a cancel is a write of the same address", async () => {
    const { harnessed, services } = await live();
    await harnessed.gateway.setPayoutWallet(harnessed.merchant.id, SHAPED, {
      kind: "signed_in",
      email: PERSON,
    });
    expect(await waiting(harnessed)).not.toBeNull();
    vi.useFakeTimers();

    const pressed = services.settings.cancel(owner(harnessed), new FormData(), undefined);
    await vi.advanceTimersByTimeAsync(WRITTEN_AFTER_MS);

    expect(await pressed).toStrictEqual({ kind: "redirect", location: "/settings" });
    expect(await waiting(harnessed)).toBeNull();
    await harnessed.stop();
  });
});
