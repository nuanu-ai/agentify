/**
 * The operator's workspace over HTTP, every one of its pages: who it answers,
 * and how an operator signs in again before an action. If these fail, a
 * signed-in merchant could read every merchant's records or press an
 * administrative action, or a stale session could act.
 */

import { CHANNEL_NAMES, inChannel } from "@agentify/ui/workspace-view";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { afterEach, describe, expect, it } from "vitest";
import routes from "../../app/routes.js";
import type { Identity } from "../identity.js";
import { flagRow } from "../testing/account-rows.js";
import { ADMIN_BASE, type AdminServed, adminServed } from "../testing/admin.js";
import { formTo, readable } from "../testing/html.js";
import { FRESH_SIGN_IN_MS } from "./access.js";

const OPERATOR = "operator@example.com";
const MERCHANT = "owner@example.com";

/** What a path's parameters are filled with where a test names nothing else. */
const SOMEBODY: Readonly<Record<string, string>> = {
  merchant_id: "mch_somebody",
  order_id: "ord_something",
  account_id: "acc_somebody",
  key_id: "mk_somebody",
};

/**
 * Every path the workspace's layout holds, nested ones included, each
 * parameter filled from `ids` (one it does not name gets its own name) and a
 * splat with a path nothing answers.
 */
const adminPaths = (ids: Readonly<Record<string, string>> = SOMEBODY): string[] => {
  const layout = (entries: readonly RouteConfigEntry[]): RouteConfigEntry | undefined =>
    entries
      .map((entry) =>
        entry.file === "routes/admin/only.tsx" ? entry : layout(entry.children ?? []),
      )
      .find((found) => found !== undefined);
  const pathsOf = (entries: readonly RouteConfigEntry[], above: string): string[] =>
    entries.flatMap((entry) => {
      const here = [above, entry.path ?? ""].filter((part) => part !== "").join("/");
      return [
        ...(entry.path === undefined && entry.index !== true ? [] : [here]),
        ...pathsOf(entry.children ?? [], here),
      ];
    });
  return pathsOf(layout(routes)?.children ?? [], "").map(
    (path) =>
      `/${path
        .replace(/:([a-z_]+)/g, (_, name: string) => ids[name] ?? name)
        .replace("*", "nothing-here")}`,
  );
};

/** A browser signed in as an account that made no merchant, which its first sign-in makes. */
const signedInWithoutMerchant = async (workspace: AdminServed, email: string) => {
  await workspace.identity.requestLink(email, "default", { client: "192.0.2.12" });
  const link = new URL(/(https?:\/\/\S+)/.exec(workspace.mails.at(-1)?.body ?? "")?.[1] ?? "");
  await workspace.identity.openLink(link.searchParams.get("token") ?? "");
  return await workspace.signedIn(email);
};

let served: AdminServed | null = null;
const serve = async (options?: Parameters<typeof adminServed>[0]) => {
  served = await adminServed(options);
  return served;
};

afterEach(async () => {
  await served?.close();
  served = null;
});

const ACTIONS = [
  "admit",
  "withdraw",
  "disable-key",
  "end-sessions",
  "grant-operator",
  "remove-operator",
  "forget",
  "health",
] as const;
type Action = (typeof ACTIONS)[number];
const TARGET = "target@example.com";

/** An actionable record for this route, with a fresh-success control after the refused press. */
const actionFixture = async (action: Action) => {
  const workspace = await serve({
    channel: action === "admit" || action === "withdraw" ? "live" : "test",
  });
  const operator = await workspace.signedIn(OPERATOR, { operator: true });
  await workspace.signedIn(TARGET, { operator: action === "remove-operator" });
  if (action === "end-sessions") await workspace.signedIn(TARGET);
  const target = await workspace.identity.byEmail(TARGET);
  if (target?.merchant === null || target === null) throw new Error("target merchant was not made");
  const merchantId = target.merchant.id;
  const key = (await workspace.harnessed.store.keysOf(merchantId))[0];
  if (key === undefined) throw new Error("target key was not issued");
  if (action === "admit") await workspace.harnessed.store.withdrawLiveApproval(merchantId);
  const merchantPath = `/admin/merchants/${merchantId}`;
  const accountPath = `/admin/accounts/${target.id}`;
  const path =
    action === "health"
      ? "/admin/health"
      : action === "admit" || action === "withdraw"
        ? `${merchantPath}/${action}`
        : action === "disable-key"
          ? `${merchantPath}/keys/${key.id}/disable`
          : `${accountPath}/${action}`;
  const destination =
    action === "health"
      ? "admin/health"
      : action === "admit" || action === "withdraw" || action === "disable-key"
        ? merchantPath.slice(1)
        : accountPath.slice(1);
  const form = { confirm: "yes", reason: "The account owner asked", check: "key" };
  const snapshot = async () =>
    JSON.stringify({
      account: (workspace.rows.dashboard_accounts ?? []).find((row) => row.id === target.id),
      sessions: (workspace.rows.dashboard_sessions ?? []).filter((row) => row.userId === target.id),
      keys: await workspace.harnessed.store.keysOf(merchantId),
      merchant: await workspace.harnessed.store.merchantById(merchantId),
      changes: (await workspace.harnessed.store.journal({ limit: 200 })).rows.filter(
        (row) => row.outcome.kind !== "refused",
      ),
    });
  const succeeds = async (browser: typeof operator) => {
    const pressed = await browser.post(path, form);
    expect(pressed.status, action).toBe(200);
    if (action === "admit" || action === "withdraw")
      expect(await workspace.harnessed.gateway.liveApproved(merchantId), action).toBe(
        action === "admit",
      );
    else if (action === "disable-key")
      expect(
        (await workspace.harnessed.store.keysOf(merchantId)).find((one) => one.id === key.id)
          ?.disabledAt,
      ).not.toBeNull();
    else if (action === "end-sessions")
      expect(
        (workspace.rows.dashboard_sessions ?? []).filter((row) => row.userId === target.id),
      ).toStrictEqual([]);
    else if (action === "forget") expect(await workspace.identity.byEmail(TARGET)).toBeNull();
    else if (action === "grant-operator" || action === "remove-operator")
      expect((await workspace.identity.operatorAccount(target.id, new Date()))?.operator).toBe(
        action === "grant-operator",
      );
    else expect(readable(pressed.html)).toMatch(/not Coinbase.*facilitator/i);
  };
  return {
    workspace,
    operator,
    path,
    destination,
    form,
    snapshot,
    succeeds,
    ids: {
      merchant_id: merchantId,
      account_id: target.id,
      key_id: key.id,
      order_id: "ord_something",
    },
  };
};

describe("who the operator's workspace answers", () => {
  it("answers a signed-in account the flag does not confirm exactly as an address the dashboard does not have, on every page, read or pressed", async () => {
    for (const action of ACTIONS) {
      const { workspace, path, form, ids, snapshot, succeeds, operator } =
        await actionFixture(action);
      const merchant = await workspace.signedIn(MERCHANT);
      const withoutMerchant = await signedInWithoutMerchant(workspace, "visitor@nowhere.example");
      const browsers = [merchant, withoutMerchant];
      if (action === "withdraw" || action === "health") {
        const published = await workspace.harnessed.gateway.publishCard(ids.merchant_id, {
          merchant_item_id: "room-101",
          title: "A room for the night",
          description: "One night in a room",
          price: { amount: "80.00", currency: "USD" },
          result: { access_code: { type: "string" } },
          fulfillment: "sync",
        });
        if (!published.ok) throw new Error("product was refused");
        const offered = await workspace.harnessed.gateway.beginPurchase(published.id, {});
        if (offered.step !== "pay") throw new Error("order was refused");
        ids.order_id = offered.order.order.id;
      }
      const before = await snapshot();
      for (const browser of browsers) {
        const nowhere = await browser.get("/admin/zzz-nothing");
        const hidden = { status: nowhere.status, to: nowhere.to, page: readable(nowhere.html) };
        // An unattached account meets the outer merchant gate before the operator check.
        expect(hidden.status, action).toBe(browser === merchant ? 404 : 303);
        if (browser === withoutMerchant) expect(hidden.to).toBe(`${ADMIN_BASE}/merchant`);
        if (action === "withdraw" || action === "health") {
          for (const method of ["get", "post"] as const)
            for (const route of adminPaths(ids)) {
              const answered =
                method === "get" ? await browser.get(route) : await browser.post(route, form);
              expect(
                { status: answered.status, to: answered.to, page: readable(answered.html) },
                `${method} ${route}`,
              ).toStrictEqual(hidden);
            }
        }
        const answered = await browser.post(path, form);
        expect(
          { status: answered.status, to: answered.to, page: readable(answered.html) },
          action,
        ).toStrictEqual(hidden);
        expect(await snapshot(), action).toBe(before);
      }
      await succeeds(operator);
      await workspace.close();
      served = null;
    }
  });

  it("sends a visitor with no session to the sign-in, which returns them to the page", async () => {
    const { visitor } = await serve();
    const nobody = visitor();

    for (const path of adminPaths()) {
      const read = await nobody.get(path);
      expect(read.status, path).toBe(303);
      expect(read.to, path).toMatch(new RegExp(`^${ADMIN_BASE}/sign-in`));
    }
    expect((await nobody.get("/admin/merchants/mch_somebody")).to).toBe(
      `${ADMIN_BASE}/sign-in?destination=admin/merchants/mch_somebody`,
    );
    // What the lookup was asked does not travel; the sign-in returns to the overview.
    expect((await nobody.get("/admin/find?q=ord_1")).to).toBe(
      `${ADMIN_BASE}/sign-in?destination=admin`,
    );
  });

  it("gives the lookup's own page one search box, and every other page the bar's", async () => {
    const { signedIn } = await serve({ channel: "live" });
    const operator = await signedIn(OPERATOR, { operator: true });
    const boxes = (html: string) => html.match(/<input[^>]*type="search"/g)?.length ?? 0;

    expect(boxes((await operator.get("/admin/find?q=ord_1")).html)).toBe(1);
    expect(boxes((await operator.get("/admin/health")).html)).toBe(1);
  });

  it("answers an operator on every page, in the workspace's frame, naming the channel", async () => {
    const { signedIn, harnessed } = await serve({ channel: "live" });
    const operator = await signedIn(OPERATOR, { operator: true });
    const ids = {
      ...SOMEBODY,
      merchant_id: harnessed.merchant.id,
      key_id: harnessed.merchant.keyId,
    };

    const paths = adminPaths(ids);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/admin",
        "/admin/merchants",
        `/admin/merchants/${ids.merchant_id}`,
        "/admin/orders",
        "/admin/orders/ord_something",
        "/admin/find",
        "/admin/money",
        "/admin/health",
        "/admin/accounts",
        "/admin/journal",
      ]),
    );
    for (const path of paths.filter((one) => !one.endsWith("/sign-in-again"))) {
      // A press's own address, read, leads to the page its form lives on,
      // which is then held to everything a page is.
      const first = await operator.get(path);
      const read =
        first.status === 303 && first.to?.startsWith(`${ADMIN_BASE}/admin`)
          ? await operator.get(first.to.slice(ADMIN_BASE.length))
          : first;
      // A record the walk makes up is drawn in the frame as one there is none of.
      const madeUp = path.endsWith("nothing-here") || path.includes("acc_somebody");
      expect(read.status, path).toBe(madeUp ? 404 : 200);
      expect(readable(read.html), path).toContain(CHANNEL_NAMES.live);
      expect(readable(read.html), path).toContain("Operator");
    }
  });

  it("answers a page whose read failed inside the workspace's frame, offering the same address again", async () => {
    // Thrown out to the seller dashboard's own error page, an operator would
    // lose their place and be offered a way into a merchant's screens.
    const gone = async (): Promise<never> => {
      throw new Error("the database does not answer");
    };
    const workspace = await serve({
      channel: "live",
      reader: (real) => ({
        ...real,
        merchants: { ...real.merchants, list: gone, merchant: gone },
      }),
      identity: (real) => ({ ...real, operatorAccounts: gone }) as Identity,
    });
    const operator = await workspace.signedIn(OPERATOR, { operator: true });

    for (const path of [
      "/admin/merchants?show=waiting",
      `/admin/merchants/${workspace.harnessed.merchant.id}`,
      "/admin/accounts?show=operators",
    ]) {
      const read = await operator.get(path);
      expect(read.status, path).toBe(500);
      expect(readable(read.html), path).toContain(CHANNEL_NAMES.live);
      expect(read.html, path).toContain('aria-label="Admin sections"');
      expect(read.html, path).toContain(`href="${ADMIN_BASE}${path.replace("&", "&amp;")}"`);
      expect(read.html, path).not.toContain(`href="${ADMIN_BASE}/products"`);
    }
  });

  it("answers Orders and an order inside the workspace's frame where their read answers what the page cannot draw", async () => {
    // Each read there catches its own failure; anything else that throws on
    // the way to the page is still said in the frame, never on the seller
    // dashboard's error page.
    const malformed = async (): Promise<never> => undefined as never;
    const workspace = await serve({
      channel: "live",
      reader: (real) => ({
        ...real,
        orders: { ...real.orders, orders: malformed, order: malformed },
      }),
    });
    const operator = await workspace.signedIn(OPERATOR, { operator: true });

    for (const path of ["/admin/orders?segment=unfulfilled", "/admin/orders/ord_something"]) {
      const read = await operator.get(path);
      expect(read.status, path).toBe(500);
      expect(readable(read.html), path).toContain(CHANNEL_NAMES.live);
      expect(read.html, path).toContain('aria-label="Admin sections"');
      expect(read.html, path).toContain(`href="${ADMIN_BASE}${path}"`);
      expect(read.html, path).not.toContain(`href="${ADMIN_BASE}/products"`);
    }
  });

  it("answers no such page to an operator whose flag was taken away, from the next request", async () => {
    const { signedIn, rows } = await serve();
    const operator = await signedIn(OPERATOR, { operator: true });
    expect((await operator.get("/admin/merchants")).status).toBe(200);

    flagRow(rows, OPERATOR, false);

    expect((await operator.get("/admin/merchants")).status).toBe(404);
  });

  it("answers no such page to everybody while the identity cannot read the flag", async () => {
    // The gate's own read goes on working; only the workspace's read fails.
    const { signedIn } = await serve({
      identity: (real) =>
        ({
          ...real,
          whoIs: async (cookie: string | undefined, reading?: { renew?: boolean }) => {
            if (reading?.renew === false) throw new Error("the identity is gone");
            return await real.whoIs(cookie, reading);
          },
        }) as Identity,
    });
    const operator = await signedIn(OPERATOR, { operator: true });

    expect((await operator.get("/admin/merchants")).status).toBe(404);
  });
});

describe("signing in again before an action", () => {
  const BACK_TO = "admin/merchants/mch_somebody";

  it("mails a link that says it confirms an action, which returns this browser to the page it was asked on", async () => {
    const workspace = await serve();
    // A merchant that is there, so its page answers once the browser is back.
    const backTo = `admin/merchants/${workspace.harnessed.merchant.id}`;
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    // An operator with no merchant of their own, as most are.
    for (const row of workspace.rows.dashboard_accounts ?? []) {
      if (row.email === OPERATOR) row.merchantId = null;
    }
    workspace.ageSessions(FRESH_SIGN_IN_MS + 60_000);

    const asked = await operator.post("/admin/sign-in-again", { destination: backTo });

    expect(asked.status).toBe(202);
    expect(readable(asked.html)).toContain(`A link is on its way to ${OPERATOR}`);
    const mail = workspace.mails.at(-1);
    expect(mail?.to).toBe(OPERATOR);
    expect(mail?.subject).toBe("Confirm an administrative action on Agentify");
    expect(mail?.body).toContain("If you did not ask for this");
    // A mail has no band, so it names its environment in words.
    expect(mail?.body).toContain(inChannel(workspace.config.surfaceMode));
    const link = new URL(/(https?:\/\/\S+)/.exec(mail?.body ?? "")?.[1] ?? "");
    const opened = await operator.post("/sign-in/open", {
      token: link.searchParams.get("token") ?? "",
    });
    expect(opened.to).toBe(`${ADMIN_BASE}/${backTo}`);
    // Signed in afresh: the page answers, and its sign-in is now.
    expect((await operator.get(`/${backTo}`)).status).toBe(200);
    const session = workspace.rows.dashboard_sessions?.at(-1);
    expect(Date.now() - new Date(session?.createdAt as Date).getTime()).toBeLessThan(
      FRESH_SIGN_IN_MS,
    );
  });

  it("is not spent by somebody typing the operator's address on the public sign-in form", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    // The public form's hour for the address, spent to the last link.
    for (let sent = 0; sent < 3; sent += 1) {
      await workspace.identity.requestLink(OPERATOR, "default", { client: "198.51.100.7" });
      for (const row of workspace.rows.dashboard_link_sends ?? []) {
        row.sentAt = new Date(new Date(row.sentAt as Date).getTime() - 61_000);
      }
    }
    expect(
      (await workspace.identity.requestLink(OPERATOR, "default", { client: "198.51.100.7" }))
        .status,
    ).toBe("cooldown");

    const asked = await operator.post("/admin/sign-in-again", { destination: BACK_TO });

    expect(asked.status).toBe(202);
  });

  it("returns to no page outside the workspace's own", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    const sent = workspace.mails.length;

    for (const destination of ["settings", "admin/live-sales", "https://evil.example/admin", ""]) {
      const asked = await operator.post("/admin/sign-in-again", { destination });
      expect(asked.status, destination).toBe(400);
    }
    expect(workspace.mails.length).toBe(sent);
  });

  it("leads a read of the press's own address to the overview", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });

    expect((await operator.get("/admin/sign-in-again")).to).toBe(`${ADMIN_BASE}/admin`);
  });
});

describe("a page read with a sign-in older than fifteen minutes", () => {
  it("asks for a fresh sign-in where its actions are, before the operator types a reason", async () => {
    // A reason typed into a form the press then refuses for the sign-in's age
    // is a reason written twice.
    const workspace = await serve({ channel: "live" });
    const { harnessed, identity } = workspace;
    await identity.make(MERCHANT, harnessed.merchant.id);
    const account = (await identity.byEmail(MERCHANT))?.id ?? "acc_missing";
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    const pages = [`/admin/merchants/${harnessed.merchant.id}`, `/admin/accounts/${account}`];
    for (const path of pages) {
      expect((await operator.get(path)).html, path).toContain('name="reason"');
    }

    workspace.ageSessions(FRESH_SIGN_IN_MS + 60_000);

    for (const path of pages) {
      const read = await operator.get(path);
      expect(read.html, path).toContain(`action="${ADMIN_BASE}/admin/sign-in-again"`);
      expect(read.html, path).not.toContain('name="reason"');
    }
  });
});

describe("a press made with a sign-in older than fifteen minutes", () => {
  it("is answered on every page of the workspace with the step-up, or refused, and changes nothing", async () => {
    for (const action of ACTIONS) {
      const { workspace, operator, path, destination, form, snapshot, succeeds } =
        await actionFixture(action);
      workspace.ageSessions(FRESH_SIGN_IN_MS + 60_000);
      const before = await snapshot();
      const pressed = await operator.post(path, form);
      expect(pressed.status, action).toBe(200);
      const step = formTo(pressed.html, "post", `${ADMIN_BASE}/admin/sign-in-again`);
      expect(step, action).toBeDefined();
      expect(step?.fields.get("destination"), action).toBe(destination);
      expect(readable(pressed.html), action).toMatch(/sign in again to act/i);
      expect(await snapshot(), action).toBe(before);
      const fresh = await workspace.signedIn(OPERATOR, { operator: true });
      await succeeds(fresh);
      await workspace.close();
      served = null;
    }
  });
});

/**
 * What each link on a page into the workspace says, in the order the page
 * draws them: any link to an address at or under an `admin` segment, however
 * it is written.
 */
const doorsIn = (html: string): string[] =>
  [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .filter(([, href]) => /(?:^|\/)admin(?:[/?#]|$)/.test(href ?? ""))
    .map(([, , words]) => readable(words ?? ""));

/** Whether a page shows or links any way into the workspace. */
const anyDoorIn = (html: string): boolean =>
  doorsIn(html).length > 0 || /\bAdmin\b/.test(readable(html));

describe("the door into the workspace from the merchant's dashboard", () => {
  it("stands in an operator's header, saying Admin, in the row and in the menu, and nowhere for an account the flag does not confirm", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    const merchant = await workspace.signedIn(MERCHANT);

    for (const path of ["/products", "/orders", "/settings"]) {
      expect(doorsIn((await operator.get(path)).html), path).toStrictEqual(["Admin", "Admin"]);
      expect(anyDoorIn((await merchant.get(path)).html), path).toBe(false);
    }
  });

  it("is not named in the data a merchant's page is drawn from, while an operator's carries the flag", async () => {
    // A merchant's browser is not told the workspace exists, not even that
    // their account lacks the flag for it.
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    const merchant = await workspace.signedIn(MERCHANT);

    const merchants = await merchant.get("/products.data");
    expect(merchants.status).toBe(200);
    expect(merchants.html).not.toMatch(/admin|"operator"/i);
    expect((await operator.get("/products.data")).html).toContain('"operator"');
  });

  it("is gone from the next request once the flag is taken away", async () => {
    const { signedIn, rows } = await serve();
    const operator = await signedIn(OPERATOR, { operator: true });
    expect(doorsIn((await operator.get("/products")).html)).not.toStrictEqual([]);

    flagRow(rows, OPERATOR, false);

    expect(anyDoorIn((await operator.get("/products")).html)).toBe(false);
  });

  it("is not drawn on a page drawn where the flag could not be read", async () => {
    // The gate's own read goes on working; only the workspace's read fails, so
    // its page is drawn with nothing any loader read.
    const { signedIn } = await serve({
      identity: (real) =>
        ({
          ...real,
          whoIs: async (cookie: string | undefined, reading?: { renew?: boolean }) => {
            if (reading?.renew === false) throw new Error("the identity is gone");
            return await real.whoIs(cookie, reading);
          },
        }) as Identity,
    });
    const operator = await signedIn(OPERATOR, { operator: true });

    const refused = await operator.get("/admin/merchants");

    expect(refused.status).toBe(404);
    expect(readable(refused.html)).toContain(OPERATOR);
    expect(anyDoorIn(refused.html)).toBe(false);
  });
});
