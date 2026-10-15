/**
 * Local form correctness: eight actions, four request contexts, two merchant
 * positions. Each accepted form is submitted twice. The real routes, identity
 * component and gateway decide effects; only the merchant's shop documents and
 * email handover are local fixtures. This is not browser navigation coverage.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Harness, harness } from "@agentify/gateway/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { DRAWN_FOR } from "./drawn-for.js";
import { gatewayFor } from "./gateway.js";
import { type Identity, identityFor } from "./identity.js";
import { buildApp } from "./server.js";
import { testPages } from "./testing/pages.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";
import { memoryWooShops, type WooShops } from "./woo-shops.js";

const BASE = "/dashboard";
const SHOP = "https://shop.example.com";
const CONFIG = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PUBLIC_BASE_URL: "https://dashboard.example.com",
  BASE_PATH: BASE,
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
});
let real: Harness;
let identity: Identity;
let shops: WooShops;
let server: Server;
let origin: string;
const letters = new Map<string, string>();

beforeAll(async () => {
  real = await harness({ PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "sandbox:scripted" });
  shops = memoryWooShops();
  identity = identityFor(CONFIG, {
    postman: async (message) => {
      letters.set(message.to, message.body);
      return "accepted";
    },
  });
  const app = buildApp(CONFIG, {
    pages: await testPages(),
    gateway: real.gateway,
    identity,
    wooShops: shops,
    shop: {
      grantScreen: async () => ({ ok: true }),
      catalogue: async () => ({
        ok: true,
        products: [
          {
            id: 1,
            name: "Gift Message Templates",
            sku: "DL-GIFT-MESSAGES",
            type: "simple",
            description: "<p>Twenty gift-card messages delivered in one file.</p>",
            short_description: "",
            status: "publish",
            is_purchasable: true,
            is_in_stock: true,
            virtual: true,
            downloadable: true,
            manage_stock: false,
            download_limit: -1,
            download_expiry: -1,
            downloads: [],
            qualification_problem: null,
            prices: { price: "100", currency_code: "USD", currency_minor_unit: 2 },
          },
        ],
      }),
      inspectProduct: async () => ({
        ok: true,
        product: {
          kind: "download",
          productId: "1",
          downloadId: "gift-messages",
          fileName: "gift-message-templates.txt",
          price: { amount: "1.00", currency: "USD" },
          fingerprint: "local-file-fingerprint",
        },
      }),
    },
  });
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await identity?.close();
  await real?.stop();
});

const account = async (label: string) => {
  const merchant = await real.addMerchant();
  const email = `${label.toLowerCase()}-${merchant.id}@example.com`;
  const person = await identity.make(email, merchant.id);
  if (person === null) throw new Error("local account was not made");
  await identity.requestLink(email, "default");
  const token = /[?&]token=([A-Za-z0-9]+)/.exec(letters.get(email) ?? "")?.[1];
  if (token === undefined) throw new Error("local sign-in handover contained no token");
  const opened = await identity.openLink(token);
  if (opened.status !== "opened") throw new Error("local sign-in did not open");
  const cookie = opened.setCookies.map((line) => line.split(";", 1)[0]).join("; ");
  const gateway = gatewayFor(real.gateway, { merchantId: merchant.id, email });
  await gateway.setSellerSite(SHOP);
  return { merchant, person, email, cookie, gateway };
};
type Account = Awaited<ReturnType<typeof account>>;

const snapshot = async (who: Account) => {
  const [cards, keys, seller, wallet, integration, connection] = await Promise.all([
    who.gateway.cards(),
    who.gateway.keys(),
    who.gateway.seller(),
    who.gateway.payoutWallet(),
    who.gateway.integration(),
    shops.connectionOf(who.person.id),
  ]);
  return {
    cards,
    keys,
    seller,
    wallet,
    integration,
    connected:
      connection === null
        ? null
        : {
            accountId: connection.accountId,
            shopUrl: connection.shopUrl,
            revision: connection.revision,
          },
  };
};

type Action =
  | "selling"
  | "name"
  | "site"
  | "wallet"
  | "issue-key"
  | "disable-key"
  | "import"
  | "disconnect";
const ACTIONS: readonly Action[] = [
  "selling",
  "name",
  "site",
  "wallet",
  "issue-key",
  "disable-key",
  "import",
  "disconnect",
];
type Context = "accepted-repeat" | "no-session" | "stale-form" | "wrong-origin";
const CONTEXTS: readonly Context[] = [
  "accepted-repeat",
  "no-session",
  "stale-form",
  "wrong-origin",
];

const bodyOf = async (
  action: Action,
  owner: Account,
): Promise<{ path: string; form: Record<string, string>; disabled?: string }> => {
  const marked = { [DRAWN_FOR]: owner.email };
  if (action === "selling") return { path: "/cards?selling=pause", form: marked };
  if (action === "name")
    return { path: "/settings", form: { ...marked, seller_name: "Campaign seller" } };
  if (action === "site")
    return {
      path: "/settings/site",
      form: { ...marked, seller_site: "https://merchant.example.com" },
    };
  if (action === "wallet")
    return {
      path: "/settings/payout-wallet",
      form: { ...marked, payout_wallet: "0x0000000000000000000000000000000000000011" },
    };
  if (action === "issue-key") return { path: "/keys", form: { ...marked, label: "Campaign key" } };
  if (action === "disable-key") {
    const key = await owner.gateway.issueKey("Campaign revoke target");
    if (!key.ok) throw new Error("local key was not issued");
    return {
      path: `/keys/${key.document.key.id}/disable`,
      form: marked,
      disabled: key.document.key.id,
    };
  }
  await owner.gateway.sellThrough("woocommerce");
  await shops.connect({
    accountId: owner.person.id,
    shopUrl: SHOP,
    consumerKey: "ck_fixture",
    consumerSecret: "cs_fixture",
    permissions: "read_write",
    revision: "local-grant",
    connectedAt: new Date("2026-10-15T12:00:00Z"),
  });
  return {
    path: action === "import" ? "/woocommerce/import" : "/woocommerce/disconnect",
    form: marked,
  };
};

const expectEffect = async (
  action: Action,
  owner: Account,
  before: Awaited<ReturnType<typeof snapshot>>,
  repetitions: number,
  disabled?: string,
) => {
  const after = await snapshot(owner);
  if (action === "selling")
    expect(after.cards).toMatchObject({ ok: true, document: { selling: "paused" } });
  if (action === "name")
    expect(after.seller).toMatchObject({ ok: true, document: { name: "Campaign seller" } });
  if (action === "site")
    expect(after.seller).toMatchObject({
      ok: true,
      document: { site: "https://merchant.example.com" },
    });
  if (action === "wallet")
    expect(after.wallet).toMatchObject({
      ok: true,
      document: { payout_wallet: "0x0000000000000000000000000000000000000011" },
    });
  if (action === "issue-key") {
    if (!after.keys.ok || !before.keys.ok) throw new Error("local keys could not be read");
    expect(after.keys.document.length - before.keys.document.length).toBe(repetitions);
    expect(new Set(after.keys.document.map((key) => key.id)).size).toBe(after.keys.document.length);
  }
  if (action === "disable-key") {
    if (!after.keys.ok) throw new Error("local keys could not be read");
    expect(after.keys.document.find((key) => key.id === disabled)).toMatchObject({
      disabled_at: expect.any(String),
    });
  }
  if (action === "import") {
    if (!after.cards.ok) throw new Error("local cards could not be read");
    expect(after.cards.document.cards).toHaveLength(1);
    expect(after.cards.document.cards[0]?.card.title).toBe("Gift Message Templates");
  }
  if (action === "disconnect") {
    expect(after.connected).toBeNull();
    expect(after.integration).toMatchObject({ ok: true, document: { through: "api" } });
  }
  return after;
};

describe("campaign: 64 form contexts across two merchant positions", () => {
  for (const action of ACTIONS)
    for (const context of CONTEXTS)
      for (const position of [0, 1]) {
        it(`${action}/${context}/merchant-${position}`, async () => {
          const pair = await Promise.all([account("A"), account("B")]);
          const owner = pair[position];
          const other = pair[1 - position];
          if (owner === undefined || other === undefined) throw new Error("missing local merchant");
          const body = await bodyOf(action, owner);
          const [beforeOwner, beforeOther] = await Promise.all([snapshot(owner), snapshot(other)]);
          const submit = async () => {
            const response = await fetch(`${origin}${BASE}${body.path}`, {
              method: "POST",
              redirect: "manual",
              body: new URLSearchParams(body.form),
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                ...(context === "no-session"
                  ? {}
                  : { cookie: context === "stale-form" ? other.cookie : owner.cookie }),
                origin: context === "wrong-origin" ? "https://unrelated.example.com" : origin,
              },
            });
            const html = await response.text();
            expect(html).not.toContain("cs_fixture");
            return { status: response.status, to: response.headers.get("location") };
          };
          const first = await submit();
          if (context === "accepted-repeat") {
            expect(first.status).toBeLessThan(400);
            const afterFirst = await expectEffect(action, owner, beforeOwner, 1, body.disabled);
            const second = await submit();
            expect(second.status).toBeLessThan(400);
            const afterSecond = await expectEffect(action, owner, beforeOwner, 2, body.disabled);
            if (action !== "issue-key") expect(afterSecond).toEqual(afterFirst);
          } else {
            expect(first.status).toBe(
              context === "no-session" ? 303 : context === "stale-form" ? 409 : 403,
            );
            expect(await snapshot(owner)).toEqual(beforeOwner);
          }
          expect(await snapshot(other)).toEqual(beforeOther);
        });
      }
});
