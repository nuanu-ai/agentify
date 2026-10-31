import { onboardingAccountView } from "../../src/onboarding.js";
// @vitest-environment jsdom

/**
 * A switch on the cards pressed in a live document, where the page's script
 * sends it and then reads the cards again. Until the cards answering the press
 * are drawn, the page still shows the state from before it, so the pressed
 * button must not be offered again in the meantime.
 */

import { MerchantCardListSchema } from "@nuanu-ai/agentify-contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, Outlet, redirect } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { keysView } from "../../src/keys.js";
import { nextStepOf } from "../../src/next-step.js";
import type { OnboardingView } from "../../src/onboarding.js";
import { NAME_RULE } from "../../src/seller-name.js";
import { ONBOARDING_CASES } from "../../src/testing/onboarding-cases.js";
import type { Viewer } from "../../src/viewer.js";
import { cardsView } from "../../src/views.js";
import { CardsScreen } from "./cards.js";
import { ProductsCatalog } from "./products-catalog.js";

const SEEN_BY: Viewer = {
  base: "",
  mode: "sandbox",
  who: "owner@example.com",
  confirmed: true,
  sellerName: "Freeland",
};

const cards = MerchantCardListSchema.parse({
  selling: "open",
  cards: [
    {
      id: "itm_1",
      as_of: "2026-08-26T09:00:00Z",
      card: {
        merchant_item_id: "room-101",
        title: "A room for the night",
        description: "One night in room 101",
        price: { amount: "80.00", currency: "USD" },
        result: { access_code: { type: "string" } },
        fulfillment: "sync",
      },
      selling: "open",
      paused: false,
    },
  ],
});

afterEach(cleanup);

/**
 * The cards in a live document, inside the gate. The press answers with the
 * redirect back to the cards, and
 * the cards read again after it wait until the test lets them through.
 */
const pressable = () => {
  const state = { pressed: 0, release: (): void => undefined };
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      Component: Outlet,
      children: [
        {
          id: "routes/gate",
          loader: () => ({ who: SEEN_BY.who }),
          children: [
            {
              id: "routes/products",
              path: "products",
              Component: () => <CardsScreen view={cardsView(cards, "https://agentify.ad")} />,
              loader: async () => {
                if (state.pressed > 0) {
                  await new Promise<void>((resolve) => {
                    state.release = resolve;
                  });
                }
                return null;
              },
              action: () => {
                state.pressed += 1;
                return redirect("/products");
              },
            },
          ],
        },
      ],
    },
  ]);
  render(
    <Stub
      initialEntries={["/products"]}
      hydrationData={{
        loaderData: { root: null, "routes/gate": { who: SEEN_BY.who }, "routes/products": null },
      }}
    />,
  );
  return state;
};

describe("a switch pressed on the cards", () => {
  it("stays busy until the cards answering the press are drawn", async () => {
    const press = pressable();
    const button = screen.getByRole("button", { name: "Pause" });

    fireEvent.click(button);
    await waitFor(() => expect(press.pressed).toBe(1));
    await act(async () => undefined);

    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);

    await act(async () => press.release());

    await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    expect(button.hasAttribute("disabled")).toBe(false);
  });
});

it("keeps asking for live sales as the one filled action while global and individual products are paused", async () => {
  const situation = ONBOARDING_CASES.find((one) => one.row === 31);
  if (!situation) throw new Error("missing withdrawal situation");
  const onboarding: OnboardingView = {
    mode: "live",
    step: nextStepOf({ ...situation.facts, selling: "paused" }),
    keys: keysView([]),
    contact: null,
    origin: "https://agentify.ad",
    unread: false,
    account: onboardingAccountView(nextStepOf({ ...situation.facts, selling: "paused" }), {
      sellerName: "Freeland",
      savedWallet: null,
      nameRule: NAME_RULE,
      wallet: null,
      email: SEEN_BY.who,
      request: null,
      decision: { at: { text: "30 Oct 2026, 09:00 UTC" }, note: "Use the name buyers know." },
    }),
  };
  const view = cardsView(
    {
      ...cards,
      selling: "paused",
      cards: cards.cards.map((row) => ({ ...row, paused: true, selling: "paused" as const })),
    },
    "https://agentify.ad",
  );
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      children: [
        {
          id: "routes/gate",
          children: [
            {
              id: "routes/merchant-only",
              children: [
                {
                  path: "products",
                  Component: () => (
                    <ProductsCatalog view={view} base="" shop={undefined} account={onboarding} />
                  ),
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
  render(
    <Stub
      initialEntries={["/products"]}
      hydrationData={{
        loaderData: {
          root: {
            base: "",
            surface: { attribute: "data-agentify-surface", mode: "live", words: null },
          },
          "routes/gate": { who: SEEN_BY.who },
          "routes/merchant-only": { account: [], onboarding },
        },
      }}
    />,
  );
  await screen.findByRole("button", { name: "Ask again" });
  expect(
    [...document.querySelectorAll("button.button-primary, a.button-primary")].map(
      (element) => element.textContent,
    ),
  ).toEqual(["Ask again"]);
  expect(screen.getByRole("button", { name: "Resume all sales" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Resume" })).toBeDefined();
});
