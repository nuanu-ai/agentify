// @vitest-environment jsdom

/**
 * A switch on the cards pressed in a live document, where the page's script
 * sends it and then reads the cards again. Until the cards answering the press
 * are drawn, the page still shows the state from before it, so the pressed
 * button must not be offered again in the meantime.
 */

import { MerchantCardListSchema } from "@nuanu-ai/agentify-contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, redirect } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { Viewer } from "../../src/screens.js";
import { cardsView } from "../../src/views.js";
import { CardsScreen } from "./cards.js";

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

describe("a switch pressed on the cards", () => {
  it("stays busy until the cards answering the press are drawn", async () => {
    let pressed = 0;
    let release = (): void => undefined;
    const Stub = createRoutesStub([
      {
        id: "routes/gate",
        path: "/",
        loader: () => ({ who: SEEN_BY.who }),
        children: [
          {
            id: "routes/cards",
            path: "cards",
            Component: () => (
              <CardsScreen view={cardsView(SEEN_BY, cards, "https://agentify.ad")} base="" />
            ),
            // The cards read again after the press wait until the test lets
            // them through.
            loader: async () => {
              if (pressed > 0) await new Promise<void>((resolve) => (release = resolve));
              return null;
            },
            action: () => {
              pressed += 1;
              return redirect("/cards");
            },
          },
        ],
      },
    ]);
    render(
      <Stub
        initialEntries={["/cards"]}
        hydrationData={{
          loaderData: { "routes/gate": { who: SEEN_BY.who }, "routes/cards": null },
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "Pause" });

    fireEvent.click(button);
    await waitFor(() => expect(pressed).toBe(1));
    await act(async () => undefined);

    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);

    await act(async () => release());

    await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    expect(button.hasAttribute("disabled")).toBe(false);
  });
});
