/**
 * Overview, Money and Health served over HTTP to an operator, as a browser
 * with no script reads them: every page says when its figures were read, and
 * a Check now press is answered with the page carrying the check's answer.
 * The channel's facilitator here is the sandbox's, so the key check asks
 * nobody; nothing here reaches the network.
 */

import { afterEach, describe, expect, it } from "vitest";
import { type AdminServed, adminServed } from "../testing/admin.js";
import { readable } from "../testing/html.js";

const OPERATOR = "operator@example.com";
const SECOND = "second@example.com";
const AS_OPERATOR = { confirm: "yes", reason: "Joins the team that looks after the channel" };

let served: AdminServed | null = null;

afterEach(async () => {
  await served?.close();
  served = null;
});

const anOperator = async () => {
  served = await adminServed();
  return await served.signedIn(OPERATOR, { operator: true });
};

describe("the figures' pages", () => {
  it("draw the overview's figures, chart and funnel, each with when it was read", async () => {
    const operator = await anOperator();

    const page = readable((await operator.get("/admin")).html);

    expect(page).toContain("figures read");
    expect(page).toContain("Settled sales · last 30 days");
    expect(page).toContain("How far merchants got");
    expect(page).toContain("Latest in the journal");
  });

  it("say the overview's latest journal rows in the Journal's own words", async () => {
    served = await adminServed();
    const operator = await served.signedIn(OPERATOR, { operator: true });
    await served.signedIn(SECOND);
    const id = (await served.identity.byEmail(SECOND))?.id ?? "";
    await operator.post(`/admin/accounts/${id}/grant-operator`, AS_OPERATOR);

    const overview = readable((await operator.get("/admin")).html);
    const journal = readable((await operator.get("/admin/journal")).html);

    const said = `Made ${SECOND} an operator`;
    expect(journal).toContain(said);
    expect(overview).toContain(said);
  });

  it("draw the overview's and the Journal's rows by identifier where the addresses cannot be read", async () => {
    let addressesRead = true;
    served = await adminServed({
      identity: (real) => ({
        ...real,
        accountsNamed: async (named) => {
          if (!addressesRead) throw new Error("the connection dropped");
          return await real.accountsNamed(named);
        },
      }),
    });
    const operator = await served.signedIn(OPERATOR, { operator: true });
    await served.signedIn(SECOND);
    const id = (await served.identity.byEmail(SECOND))?.id ?? "";
    await operator.post(`/admin/accounts/${id}/grant-operator`, AS_OPERATOR);
    addressesRead = false;

    for (const path of ["/admin", "/admin/journal"]) {
      const page = readable((await operator.get(path)).html);
      expect(page).toContain(id);
      expect(page).toContain("an operator");
      expect(page).not.toContain("a deleted account");
      expect(page).not.toContain(SECOND);
    }
  });

  it("draw Money with its splits and the operator's payout", async () => {
    const operator = await anOperator();

    const page = readable((await operator.get("/admin/money?period=7d")).html);

    expect(page).toContain("The operator's payout");
    expect(page).toContain("Settled per day · last 30 days");
  });

  it("answer a Check now press with Health carrying the check's answer", async () => {
    const operator = await anOperator();

    const pressed = await operator.post("/admin/health", { check: "key" });

    expect(pressed.status).toBe(200);
    expect(readable(pressed.html)).toContain("is not Coinbase's facilitator");
  });
});
