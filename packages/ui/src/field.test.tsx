// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Field } from "./field.js";

afterEach(cleanup);

/** What a screen reader reads out with the box: the elements its description names. */
const describedBy = (box: HTMLElement): string =>
  (box.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id)?.textContent ?? `(nothing has the id ${id})`)
    .join(" ");

describe("a field", () => {
  it("is named by its label", () => {
    render(<Field label="Email address" name="email" />);

    expect(screen.getByLabelText("Email address").getAttribute("name")).toBe("email");
  });

  it("shows why what was typed was refused, and has it read out with the box", () => {
    render(
      <Field
        label="Email address"
        name="email"
        hint="We send the link here."
        error="Enter an address of the shape someone@example.com."
      />,
    );
    const box = screen.getByLabelText("Email address");

    expect(screen.getByText("Enter an address of the shape someone@example.com.")).toBeTruthy();
    expect(describedBy(box)).toBe("Enter an address of the shape someone@example.com.");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    // The refusal takes the hint's place rather than sitting under it.
    expect(screen.queryByText("We send the link here.")).toBeNull();
  });

  it("has its hint read out with the box while nothing is wrong, and is not marked invalid", () => {
    render(<Field label="Email address" name="email" hint="We send the link here." />);
    const box = screen.getByLabelText("Email address");

    expect(describedBy(box)).toBe("We send the link here.");
    expect(box.getAttribute("aria-invalid")).toBeNull();
  });

  it("names no description when there is no line under the box", () => {
    render(<Field label="Email address" name="email" />);

    expect(screen.getByLabelText("Email address").hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps two fields on one page apart", () => {
    render(
      <>
        <Field label="Seller name" name="seller_name" error="Too long." />
        <Field label="Site" name="seller_site" error="Not an address." />
      </>,
    );

    expect(describedBy(screen.getByLabelText("Seller name"))).toBe("Too long.");
    expect(describedBy(screen.getByLabelText("Site"))).toBe("Not an address.");
  });
});
