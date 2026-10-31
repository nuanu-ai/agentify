// @vitest-environment jsdom

import { runInNewContext } from "node:vm";
import { within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { MerchantView } from "../src/admin/merchants.js";
import { MERCHANTS_STATES } from "./admin-gallery/merchants.js";
import { gallery } from "./gallery.js";
import observer from "./operator-shop-job.js?raw";

it("refreshes the operator's job and current connection without replacing an admission draft", async () => {
  const pages = ["progress", "reconnect", "earlier-reconnect", "progress"].map((job) => {
    const id = `dashboard-admin-merchant-shop-job-${job}`;
    const state = gallery.states.find((one) => one.id === id);
    const view = MERCHANTS_STATES.find((one) => one.id === id)?.loaded?.["routes/admin/merchant"] as
      | MerchantView
      | undefined;
    if (!state || !view?.shopJob) throw new Error(`the gallery has no operator job ${job}`);
    return { html: renderToString(state.draw()), job: view.shopJob };
  });
  document.body.innerHTML = pages[0]?.html ?? "";
  const draft = within(document.body).getByRole("checkbox") as HTMLInputElement;
  draft.checked = true;
  draft.focus();
  expect(within(document.body).getByRole("heading", { name: "Checking products" })).toBeTruthy();
  let response = pages[0];
  const fetchPage: typeof fetch = async (input) => {
    if (!response) throw new Error("no operator page response");
    return new Response(
      String(input).includes("/shop-job") ? JSON.stringify(response.job) : response.html,
      {
        headers: {
          "content-type": String(input).includes("/shop-job") ? "application/json" : "text/html",
        },
      },
    );
  };
  vi.useFakeTimers();
  try {
    runInNewContext(observer, {
      document,
      location,
      Intl,
      AbortController,
      DOMParser,
      fetch: fetchPage,
      setTimeout,
      clearTimeout,
      addEventListener: window.addEventListener.bind(window),
    });
    await vi.advanceTimersByTimeAsync(0);
    for (const [at, heading, connection] of [
      [1, "Check stopped", "Reconnect required"],
      [2, "Earlier check result", "Connected"],
      [3, "Checking products", "Connected"],
    ] as const) {
      response = pages[at];
      await vi.advanceTimersByTimeAsync(at === 1 ? 1000 : 5000);
      expect(within(document.body).getByRole("heading", { name: heading })).toBeTruthy();
      const integration = within(document.body).getByRole("region", { name: "Integration" });
      expect(within(integration).getByText(connection, { exact: true })).toBeTruthy();
      expect(within(document.body).getByRole("checkbox")).toBe(draft);
      expect(draft.checked).toBe(true);
      expect(document.activeElement).toBe(draft);
    }
  } finally {
    window.dispatchEvent(new Event("pagehide"));
    vi.useRealTimers();
    document.body.replaceChildren();
  }
});
