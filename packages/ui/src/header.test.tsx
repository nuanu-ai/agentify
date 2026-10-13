// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { SectionNav, SignedIn } from "./header.js";

afterEach(cleanup);

/** The parts link through the router, so they are drawn inside one. */
const inRouter = (element: () => ReactElement) => {
  const Stub = createRoutesStub([{ path: "*", Component: element }]);
  return render(<Stub initialEntries={["/orders"]} />);
};

describe("the sections", () => {
  it("names the one on screen as current and links every other", () => {
    inRouter(() => (
      <SectionNav
        label="Dashboard sections"
        sections={[
          { key: "cards", label: "Cards", to: "/cards" },
          { key: "orders", label: "Orders", to: "/orders", current: true },
          { key: "settings", label: "Settings", href: "/dashboard/settings" },
        ]}
      />
    ));
    const nav = screen.getByRole("navigation", { name: "Dashboard sections" });

    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Orders");
    expect(screen.getByText("Orders").closest("a")).toBeNull();
    expect(screen.getByText("Cards").closest("a")?.getAttribute("href")).toBe("/cards");
    expect(screen.getByText("Settings").closest("a")?.getAttribute("href")).toBe(
      "/dashboard/settings",
    );
  });
});

describe("who is signed in", () => {
  it("shows the whole address and a sign-out that posts", () => {
    const { container } = inRouter(() => (
      <SignedIn
        who="a-rather-long-address@example.com"
        account="/dashboard/settings"
        signOut="/sign-out"
      />
    ));

    const address = screen.getByText("a-rather-long-address@example.com");
    expect(address.getAttribute("title")).toBe("a-rather-long-address@example.com");
    expect(address.getAttribute("href")).toBe("/dashboard/settings");
    const form = container.querySelector("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe("/sign-out");
    expect(form?.textContent).toBe("Sign out");
  });
});
