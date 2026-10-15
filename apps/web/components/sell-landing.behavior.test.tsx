// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SELL_LANDING } from "../content/sell";
import { onSite } from "../testing/on-site";
import { SellLandingPage } from "./sell-landing";

afterEach(cleanup);

it("names the sale and payment diagrams for a reader navigating by region", () => {
  render(onSite(<SellLandingPage content={SELL_LANDING} />));

  expect(screen.getByRole("region", { name: SELL_LANDING.sale.label })).toBeTruthy();
  expect(screen.getByRole("region", { name: SELL_LANDING.money.map.label })).toBeTruthy();
});
