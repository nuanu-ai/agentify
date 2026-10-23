/**
 * The operator's workspace over HTTP, every one of its pages: who it answers,
 * and how an operator signs in again before an action. If these fail, a
 * signed-in merchant could read every merchant's records or press an
 * administrative action, or a stale session could act.
 */

import type { RouteConfigEntry } from "@react-router/dev/routes";
import { afterEach, describe, expect, it } from "vitest";
import routes from "../../app/routes.js";
import type { Identity } from "../identity.js";
import { ADMIN_BASE, type AdminServed, adminServed } from "../testing/admin.js";
import { readable } from "../testing/html.js";
import { FRESH_SIGN_IN_MS } from "./access.js";

const OPERATOR = "operator@example.com";
const MERCHANT = "owner@example.com";

/** Every path the workspace's layout holds, its parameters filled in. */
const adminPaths = (): string[] => {
  const layout = (entries: readonly RouteConfigEntry[]): RouteConfigEntry | undefined =>
    entries
      .map((entry) =>
        entry.file === "routes/admin/only.tsx" ? entry : layout(entry.children ?? []),
      )
      .find((found) => found !== undefined);
  const under = layout(routes)?.children ?? [];
  return under.map(
    (entry) =>
      `/${(entry.path ?? "")
        .replace(":merchant_id", "mch_somebody")
        .replace(":order_id", "ord_something")
        .replace(":account_id", "acc_somebody")
        .replace("*", "nothing-here")}`,
  );
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

describe("who the operator's workspace answers", () => {
  it("holds every page the design names", () => {
    expect(adminPaths()).toEqual(
      expect.arrayContaining([
        "/admin",
        "/admin/merchants",
        "/admin/merchants/mch_somebody",
        "/admin/orders",
        "/admin/orders/ord_something",
        "/admin/find",
        "/admin/money",
        "/admin/health",
        "/admin/accounts",
        "/admin/journal",
      ]),
    );
  });

  it("answers a signed-in account the flag does not confirm with no such page, on every page, read or pressed", async () => {
    const { signedIn } = await serve();
    const merchant = await signedIn(MERCHANT);

    for (const path of adminPaths()) {
      const read = await merchant.get(path);
      const pressed = await merchant.post(path, { confirm: "yes", reason: "Anything" });

      expect(read.status, `GET ${path}`).toBe(404);
      expect(pressed.status, `POST ${path}`).toBe(404);
      expect(readable(read.html), path).toContain("There is no such page");
      expect(read.html, path).not.toContain("op-channel");
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

  it("answers an operator on every page, in the workspace's frame, naming the channel", async () => {
    const { signedIn } = await serve({ channel: "live" });
    const operator = await signedIn(OPERATOR, { operator: true });

    for (const path of adminPaths().filter((one) => !one.endsWith("/sign-in-again"))) {
      const read = await operator.get(path);
      expect(read.status, path).toBe(path.endsWith("nothing-here") ? 404 : 200);
      expect(readable(read.html), path).toContain("Live channel");
      expect(readable(read.html), path).toContain("Operator");
    }
  });

  it("answers no such page to an operator whose flag was taken away, from the next request", async () => {
    const { signedIn, identity } = await serve();
    const operator = await signedIn(OPERATOR, { operator: true });
    expect((await operator.get("/admin/merchants")).status).toBe(200);

    await identity.setOperator(OPERATOR, false);

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
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    // An operator with no merchant of their own, as most are.
    for (const row of workspace.rows.dashboard_accounts ?? []) {
      if (row.email === OPERATOR) row.merchantId = null;
    }
    workspace.ageSessions(FRESH_SIGN_IN_MS + 60_000);

    const asked = await operator.post("/admin/sign-in-again", { destination: BACK_TO });

    expect(asked.status).toBe(202);
    expect(readable(asked.html)).toContain(`A link is on its way to ${OPERATOR}`);
    const mail = workspace.mails.at(-1);
    expect(mail?.to).toBe(OPERATOR);
    expect(mail?.subject).toBe("Confirm an administrative action on Agentify");
    expect(mail?.body).toContain("If you did not ask for this");
    const link = new URL(/(https?:\/\/\S+)/.exec(mail?.body ?? "")?.[1] ?? "");
    const opened = await operator.post("/sign-in/open", {
      token: link.searchParams.get("token") ?? "",
    });
    expect(opened.to).toBe(`${ADMIN_BASE}/${BACK_TO}`);
    // Signed in afresh: the page answers, and its sign-in is now.
    expect((await operator.get(`/${BACK_TO}`)).status).toBe(200);
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
