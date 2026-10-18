// @vitest-environment jsdom

/**
 * An identifier shown short must never stand in for the whole one: the copy
 * button carries the whole value, the whole value is in the page before its
 * script runs, and where the browser will not copy it is shown to be selected.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CodeCopy, Ident } from "./copy.js";

const ORDER = "ord_17ff00a1b2c3d4e5f60718293a4b7de3";
const ADDRESS = "https://agentify.ad/x402/itm_4593678908a2511a05cdf514d2e86abd/purchase";

/** A clipboard that keeps what it is given, as a browser over https offers one. */
const clipboard = () => {
  const held = { text: "" };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        held.text = text;
      },
    },
  });
  return held;
};

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("an identifier with its copy button", () => {
  it("shows the prefix, the first four and the last four with a visible ellipsis", () => {
    render(<Ident value={ORDER} what="order ID" />);

    expect(screen.getByText("ord_17ff…7de3")).toBeTruthy();
  });

  it("puts the whole value in its title and in what a screen reader reads", () => {
    render(<Ident value={ORDER} what="order ID" />);

    expect(screen.getByTitle(ORDER).textContent).toContain(ORDER);
    expect(screen.getByText(ORDER).className).toBe("sr-only");
  });

  it("carries the whole value in the page before its script runs", () => {
    const html = renderToString(<Ident value={ORDER} what="order ID" />);

    expect(html).toContain(`title="${ORDER}"`);
    expect(html).toContain(`>${ORDER}<`);
  });

  it("copies the whole value, not the short one, and says so", async () => {
    const held = clipboard();
    render(<Ident value={ORDER} what="order ID" />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy the whole order ID ord_17ff…7de3" }),
      );
    });

    expect(held.text).toBe(ORDER);
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("shows the whole value to be selected where the browser will not copy", async () => {
    // No clipboard at all is what a browser offers a page on plain http.
    render(<Ident value={ORDER} what="order ID" />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy the whole order ID ord_17ff…7de3" }),
      );
    });

    expect(screen.getByRole("status").textContent).toBe("Could not copy; select it");
    expect(screen.getByTitle(ORDER).textContent).toBe(ORDER);
  });

  it("leaves an identifier too short to gain from it whole", () => {
    render(<Ident value="ord_1" what="order ID" />);

    expect(screen.getByTitle("ord_1").textContent).toBe("ord_1");
  });

  it("shows the whole value where asked to, with the same button", async () => {
    const held = clipboard();
    const { container } = render(<Ident value={ORDER} what="order ID" whole />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Copy the whole order ID ${ORDER}` }));
    });

    expect(container.textContent).toBe(`${ORDER}Copied`);
    expect(container.textContent).not.toContain("…");
    expect(held.text).toBe(ORDER);
  });
});

describe("a product code with the purchase address's copy button", () => {
  it("prints the code and not the address, which is the button's title", () => {
    const html = renderToString(<CodeCopy code="esim-eu-5gb-30d" address={ADDRESS} />);
    const { container } = render(<CodeCopy code="esim-eu-5gb-30d" address={ADDRESS} />);

    expect(container.textContent).toBe("esim-eu-5gb-30d");
    expect(html).toContain(`title="Copy the purchase address: ${ADDRESS}"`);
  });

  it("copies the whole address and says so", async () => {
    const held = clipboard();
    render(<CodeCopy code="esim-eu-5gb-30d" address={ADDRESS} />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy the purchase address of esim-eu-5gb-30d" }),
      );
    });

    expect(held.text).toBe(ADDRESS);
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("shows the address where the browser will not copy", async () => {
    render(<CodeCopy code="esim-eu-5gb-30d" address={ADDRESS} />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy the purchase address of esim-eu-5gb-30d" }),
      );
    });

    expect(screen.getByText(ADDRESS)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Could not copy; select it");
  });
});
