/**
 * Where a press's redirect leads, as the browser is told: back to the page it
 * was made on it stays inside the application, so the page is read again in
 * place, and anywhere else the page loads whole. And what a request that
 * failed is said to be: a read that changed nothing, or a change nobody could
 * confirm.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/ui/surface";
import {
  type DataStrategyResult,
  data,
  UNSAFE_ErrorResponseImpl as ErrorResponseImpl,
  RouterContextProvider,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answer, notesAnswered, saidAsAsked, sendTo } from "./answer.js";
import { services } from "./services.js";

const SURFACE = { attribute: SURFACE_MARKER_ATTRIBUTE, mode: "live", words: SURFACE_WORDS.live };

const RELOAD = "x-remix-reload-document";

describe("a redirect a press answers with", () => {
  it("stays inside the application back to the page it was made on, whatever its query", () => {
    const back = sendTo("/products?q=room&page=2", new URL("http://dashboard.test/products"), "");

    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/products?q=room&page=2");
    expect(back.headers.get(RELOAD)).toBeNull();
  });

  it("hands React Router a path under the dashboard's prefix without the prefix", () => {
    const back = sendTo(
      "/dashboard/products?q=room",
      new URL("http://dashboard.test/dashboard/products"),
      "/dashboard",
    );

    expect(back.headers.get("location")).toBe("/products?q=room");
    expect(back.headers.get(RELOAD)).toBeNull();
  });

  it("loads another page whole, with a query or without", () => {
    const here = new URL("http://dashboard.test/products");

    expect(sendTo("/orders?open=true", here, "").headers.get(RELOAD)).toBe("true");
    expect(sendTo("/settings", here, "").headers.get(RELOAD)).toBe("true");
  });
});

/** What the router hands a page's request middleware, as far as it reads it. */
const asked = (method: string, address: string, signal = new AbortController().signal) =>
  ({ request: new Request(address, { method, signal }) }) as Parameters<typeof saidAsAsked>[0];

/**
 * Runs the root's middleware around what the dashboard's requests came back
 * with, and the gate's inside it for a page behind the gate.
 */
const around = async (
  args: Parameters<typeof saidAsAsked>[0],
  results: Record<string, DataStrategyResult>,
  gated = true,
): Promise<Record<string, DataStrategyResult>> =>
  (await saidAsAsked(args, async () =>
    gated
      ? ((await notesAnswered(args, async () => results)) as Record<string, DataStrategyResult>)
      : results,
  )) as Record<string, DataStrategyResult>;

/** The trouble a result now carries, as the error page reads it. */
const carried = (result: DataStrategyResult | undefined): unknown =>
  (result?.result as { data?: unknown } | undefined)?.data;

const LIST = "http://dashboard.test/dashboard/orders?show=open";

describe("a request the page's script sent that failed on its way", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a list that could not be loaded, offered again at its address, search and all, when it was a read", async () => {
    for (const failure of [
      new TypeError("Failed to fetch"),
      new ErrorResponseImpl(502, "Bad Gateway", "<h1>502 Bad Gateway</h1>"),
    ]) {
      const results = await around(asked("GET", LIST), {
        "routes/orders": { type: "error", result: failure },
      });

      expect(carried(results["routes/orders"])).toStrictEqual({
        kind: "unread",
        again: "/dashboard/orders?show=open",
      });
    }
  });

  it("is a change nobody could confirm when it was a press, and leads back to the page it was pressed on, with its place in the list", async () => {
    vi.stubGlobal("window", {
      location: new URL("http://dashboard.test/dashboard/cards?q=room&page=2"),
    });
    const results = await around(
      asked("POST", "http://dashboard.test/dashboard/cards?pause=itm_1"),
      {
        "routes/cards": { type: "error", result: new TypeError("Failed to fetch") },
      },
    );

    expect(carried(results["routes/cards"])).toStrictEqual({
      kind: "unanswered",
      reopen: "/dashboard/cards?q=room&page=2",
    });
  });

  it("keeps what the dashboard itself answered, and a redirect, as they came", async () => {
    const said = new ErrorResponseImpl(409, "", { kind: "problem", said: "Refused", again: "/x" });
    const moved = new Response(null, { status: 303, headers: { location: "/dashboard/cards" } });
    const results = {
      "routes/orders": { type: "error" as const, result: said },
      "routes/gate": { type: "error" as const, result: moved },
      "routes/merchant-only": { type: "data" as const, result: { account: [] } },
    };

    const after = await around(asked("GET", LIST), { ...results });

    expect(after["routes/orders"]?.result).toBe(said);
    expect(after["routes/gate"]?.result).toBe(moved);
    expect(after["routes/merchant-only"]).toStrictEqual(results["routes/merchant-only"]);
  });

  it("is left alone once the router gave the request up for another", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const failure = new TypeError("Failed to fetch");

    const results = await around(asked("GET", LIST, stopped.signal), {
      "routes/orders": { type: "error", result: failure },
    });

    expect(results["routes/orders"]?.result).toBe(failure);
  });

  it("says a change was made when the page read after an answered press is what failed", async () => {
    const navigation = new AbortController();
    await around(asked("POST", "http://dashboard.test/dashboard/keys", navigation.signal), {
      "routes/keys": { type: "data", result: data({ secret: "csk_test_shown_once" }, 200) },
    });

    const read = await around(
      asked("GET", "http://dashboard.test/dashboard/keys", navigation.signal),
      {
        "routes/keys": { type: "error", result: new TypeError("Failed to fetch") },
      },
    );
    const later = await around(asked("GET", "http://dashboard.test/dashboard/keys"), {
      "routes/keys": { type: "error", result: new TypeError("Failed to fetch") },
    });

    expect(carried(read["routes/keys"])).toStrictEqual({
      kind: "unread",
      again: "/dashboard/keys",
      answered: true,
    });
    expect(carried(later["routes/keys"])).toStrictEqual({
      kind: "unread",
      again: "/dashboard/keys",
    });
  });

  it("claims no change for a press outside the gate, such as asking for a sign-in link, which is answered alike whether a link went out or not", async () => {
    await around(
      asked("POST", "http://dashboard.test/dashboard/sign-in"),
      { "routes/sign-in": { type: "data", result: data({ screen: "requested" }, 202) } },
      false,
    );

    const read = await around(
      asked("GET", "http://dashboard.test/dashboard/sign-in"),
      { "routes/sign-in": { type: "error", result: new TypeError("Failed to fetch") } },
      false,
    );

    expect(carried(read["routes/sign-in"])).toStrictEqual({
      kind: "unread",
      again: "/dashboard/sign-in",
    });
  });

  it("claims no change for a press the dashboard answered with a refusal", async () => {
    const navigation = new AbortController();
    await around(asked("POST", "http://dashboard.test/dashboard/keys", navigation.signal), {
      "routes/keys": { type: "data", result: data({ problem: "Name the key" }, 400) },
    });

    const read = await around(
      asked("GET", "http://dashboard.test/dashboard/keys", navigation.signal),
      {
        "routes/keys": { type: "error", result: new TypeError("Failed to fetch") },
      },
    );

    expect(carried(read["routes/keys"])).toStrictEqual({
      kind: "unread",
      again: "/dashboard/keys",
    });
  });
});

describe("a problem the server half answered", () => {
  const context = new RouterContextProvider(
    new Map([[services, { base: "/dashboard", surface: SURFACE }]]) as never,
  );
  const thrownBy = (method: string, address: string, status: number, said: string): unknown => {
    const request = new Request(address, { method });
    try {
      answer(
        { kind: "problem", problem: { status, said } },
        { request, url: new URL(address), context },
      );
    } catch (thrown) {
      return (thrown as { data?: unknown }).data;
    }
    throw new Error("a problem was answered with a page");
  };

  it("is a page that could not be loaded when a read was not answered in time, whatever the gateway said", () => {
    expect(thrownBy("GET", LIST, 504, "Agentify didn't answer in time.")).toMatchObject({
      kind: "unread",
      again: "/dashboard/orders?show=open",
    });
  });

  it("is a change nobody could confirm when a press was not answered in time", () => {
    expect(
      thrownBy(
        "POST",
        "http://dashboard.test/dashboard/settings/site",
        504,
        "Agentify didn't answer in time.",
      ),
    ).toMatchObject({ kind: "unanswered", reopen: "/dashboard/settings/site" });
  });

  it("carries whether a refused press did nothing, where the server half knows it", () => {
    const request = new Request("http://dashboard.test/dashboard/settings/payout-wallet", {
      method: "POST",
    });
    const marked = (outcome?: "refused"): unknown => {
      try {
        answer(
          {
            kind: "problem",
            problem: { status: 503, said: "Nothing was recorded", ...(outcome ? { outcome } : {}) },
          },
          { request, url: new URL(request.url), context },
        );
      } catch (thrown) {
        return (thrown as { data?: unknown }).data;
      }
      return undefined;
    };

    expect(marked("refused")).toMatchObject({ kind: "problem", outcome: "refused" });
    expect(marked()).not.toHaveProperty("outcome");
  });

  it("keeps a refusal's own words, on a read and on a press", () => {
    expect(thrownBy("GET", LIST, 403, "This merchant is suspended")).toMatchObject({
      kind: "problem",
      said: "This merchant is suspended",
      again: "/dashboard/orders?show=open",
    });
    expect(
      thrownBy("POST", "http://dashboard.test/dashboard/keys", 409, "This key is already disabled"),
    ).toMatchObject({
      kind: "problem",
      said: "This key is already disabled",
      reopen: "/dashboard/keys",
    });
  });
});
