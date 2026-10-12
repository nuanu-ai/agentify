// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createRoutesStub, Form, useActionData } from "react-router";
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

  it("takes the focus when what was typed is refused, so the person can correct it at once", () => {
    const drawn = render(
      <>
        <Field label="Seller name" name="seller_name" />
        <button type="button">Use this name</button>
      </>,
    );
    screen.getByText("Use this name").focus();

    act(() => {
      drawn.rerender(
        <>
          <Field label="Seller name" name="seller_name" error="Too long." />
          <button type="button">Use this name</button>
        </>,
      );
    });

    expect(document.activeElement).toBe(screen.getByLabelText("Seller name"));
  });

  it("takes the focus at each refusal, though its words are the last one's", async () => {
    // A page that answers a press in place may refuse the second name in the
    // same words as the first; the box takes the focus each time.
    const Stub = createRoutesStub([
      {
        path: "/",
        action: () => ({ problem: "Use 1 to 32 characters of printable ASCII." }),
        Component: () => {
          const answer = useActionData() as { problem: string } | undefined;
          return (
            <Form method="post">
              <Field
                label="Seller name"
                name="seller_name"
                {...(answer === undefined ? {} : { error: answer.problem })}
              />
              <button type="submit">Use this name</button>
            </Form>
          );
        },
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
    const button = await screen.findByText("Use this name");

    for (const press of ["first", "second"]) {
      button.focus();
      fireEvent.click(button);
      await waitFor(() =>
        expect(document.activeElement, press).toBe(screen.getByLabelText("Seller name")),
      );
    }
  });

  it("asks a browser drawing it refused to put the cursor in it, with no script to do so", () => {
    const html = renderToString(<Field label="Seller name" name="seller_name" error="Too long." />);

    expect(html).toMatch(/<input[^>]*autofocus/i);
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
