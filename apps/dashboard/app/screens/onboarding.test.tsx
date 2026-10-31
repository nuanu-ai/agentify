// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, expect, it } from "vitest";
import { keysView } from "../../src/keys.js";
import { nextStepOf } from "../../src/next-step.js";
import { onboardingAccountView } from "../../src/onboarding.js";
import { NAME_RULE } from "../../src/seller-name.js";
import { ONBOARDING_CASES } from "../../src/testing/onboarding-cases.js";
import { OnboardingScreen } from "./onboarding.js";

afterEach(cleanup);

it.each([false, true])(
  "offers key creation but restores Other ways only before any key was issued (revoked: %s)",
  async (revoked) => {
    const initial = ONBOARDING_CASES.find((one) => one.row === 20)?.facts;
    if (initial === undefined) throw new Error("the shared situations have no code setup");
    const keys = keysView(
      revoked
        ? [
            {
              id: "key_revoked",
              label: "Order worker",
              created_at: "2026-10-30T08:00:00Z",
              last_used_at: null,
              disabled_at: "2026-10-30T09:00:00Z",
            },
          ]
        : [],
    );
    const view = {
      mode: initial.mode,
      step: nextStepOf({ ...initial, keys: revoked ? 1 : 0 }),
      keys,
      contact: null,
      origin: "https://agentify.ad",
      unread: false,
    };
    const Stub = createRoutesStub([
      {
        id: "routes/gate",
        path: "/",
        children: [{ path: "products", Component: () => <OnboardingScreen view={view} /> }],
      },
    ]);
    render(
      <Stub
        initialEntries={["/products"]}
        hydrationData={{ loaderData: { "routes/gate": { who: "owner@example.com" } } }}
      />,
    );
    const create = (await screen.findByRole("button", { name: "Create key" })) as HTMLButtonElement;
    const otherWays = screen.queryByRole("link", { name: /Other ways to add products/ });
    expect(otherWays?.getAttribute("href") ?? null).toBe(revoked ? null : "/products?ways=choose");
    expect(create.disabled).toBe(false);
    expect(create.form?.getAttribute("action")).toBe("/products");
  },
);

it("offers an approved merchant's ready code the publishing guide without asking for approval again", async () => {
  const initial = ONBOARDING_CASES.find((one) => one.row === 20)?.facts;
  if (initial === undefined) throw new Error("the shared situations have no code setup");
  const step = nextStepOf({
    ...initial,
    keys: 1,
    contact: "2026-10-30T08:00:00Z",
    contactAlive: true,
    liveApproved: true,
    sellerName: true,
    payoutWallet: true,
  });
  const view = {
    mode: initial.mode,
    step,
    keys: keysView([]),
    contact: { text: "30 Oct 2026, 08:00 UTC" },
    origin: "https://agentify.ad",
    unread: false,
    account: onboardingAccountView(step, {
      mode: initial.mode,
      sellerName: "Freeland",
      savedWallet: "0x0000000000000000000000000000000000000001",
      nameRule: NAME_RULE,
      wallet: null,
      email: "owner@example.com",
      request: null,
      decision: null,
    }),
  };
  const Stub = createRoutesStub([
    {
      id: "routes/gate",
      path: "/",
      children: [{ path: "products", Component: () => <OnboardingScreen view={view} /> }],
    },
  ]);
  render(
    <Stub
      initialEntries={["/products"]}
      hydrationData={{ loaderData: { "routes/gate": { who: "owner@example.com" } } }}
    />,
  );
  const guide = await screen.findByRole("link", { name: "Open the publishing guide" });
  expect(guide.getAttribute("href")).toBe("/docs/quickstart#_4-publish-one-card");
  expect(document.querySelector('a[href="mailto:admin@agentify.ad"]')).toBeNull();
});

it("gives a browser without clipboard access a recoverable install-command copy result", async () => {
  const initial = ONBOARDING_CASES.find((one) => one.row === 20)?.facts;
  if (initial === undefined) throw new Error("the shared situations have no code setup");
  const Stub = createRoutesStub([
    {
      id: "routes/gate",
      path: "/",
      children: [
        {
          path: "products",
          Component: () => (
            <OnboardingScreen
              view={{
                mode: initial.mode,
                step: nextStepOf(initial),
                keys: keysView([]),
                contact: null,
                origin: "https://agentify.ad",
                unread: false,
              }}
            />
          ),
        },
      ],
    },
  ]);
  render(
    <Stub
      initialEntries={["/products"]}
      hydrationData={{ loaderData: { "routes/gate": { who: "owner@example.com" } } }}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
  expect((await screen.findByRole("status")).textContent).toMatch(/select.*command/i);
});
