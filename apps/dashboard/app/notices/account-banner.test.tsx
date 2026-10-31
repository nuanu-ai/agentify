// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, expect, it } from "vitest";
import { nextStepOf } from "../../src/next-step.js";
import { type OnboardingView, onboardingAccountView } from "../../src/onboarding.js";
import { ONBOARDING_CASES } from "../../src/testing/onboarding-cases.js";
import { AccountBanner } from "./account-banner.js";

afterEach(cleanup);

it.each([false, true])(
  "keeps the operator decision beside an exchange-rate step without hiding other account reasons (unread: %s)",
  (unread) => {
    const initial = ONBOARDING_CASES.find((one) => one.row === 31)?.facts;
    if (!initial) throw new Error("the shared situations have no withdrawal");
    const step = nextStepOf({
      ...initial,
      platform: "woocommerce",
      through: "woocommerce",
      shop: "connected",
      ready: 0,
    });
    const onboarding: OnboardingView = {
      mode: "live",
      step,
      keys: null,
      contact: null,
      origin: "https://agentify.ad",
      unread,
      account: onboardingAccountView(step, {
        mode: "live",
        sellerName: "Freeland",
        savedWallet: null,
        nameRule: "",
        wallet: null,
        email: "owner@example.com",
        request: null,
        decision: {
          at: { text: "30 Oct 2026, 12:04 UTC" },
          note: "Confirm the shop's contact address.",
        },
      }),
    };
    const notes = [
      {
        reason: "not_approved" as const,
        title: "Live sales are stopped",
        says: "The saved approval was withdrawn.",
        fix: null,
      },
      {
        reason: "no_payout_wallet" as const,
        title: "Payout wallet missing",
        says: "Add your payout wallet.",
        fix: null,
      },
    ];
    const Stub = createRoutesStub([
      {
        id: "routes/merchant-only",
        path: "/",
        children: [
          {
            path: "products",
            Component: () => (
              <>
                <AccountBanner notes={notes} />
                <h2>Exchange rate</h2>
              </>
            ),
          },
        ],
      },
    ]);
    render(
      <Stub
        initialEntries={["/products"]}
        hydrationData={{ loaderData: { "routes/merchant-only": { account: notes, onboarding } } }}
      />,
    );
    const banner = screen.getByRole("region", { name: "About your account" });
    expect(banner.textContent).toContain("Add your payout wallet.");
    expect(banner.textContent?.includes("Confirm the shop's contact address.")).toBe(!unread);
    expect(banner.textContent?.includes("The saved approval was withdrawn.")).toBe(unread);
    expect(screen.getAllByRole("region")).toHaveLength(1);
  },
);
