// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button.js";

afterEach(cleanup);

describe("a button", () => {
  it("sends its form when pressed", () => {
    const sent = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    render(
      <form onSubmit={sent}>
        <Button>Send me a sign-in link</Button>
      </form>,
    );

    fireEvent.click(screen.getByText("Send me a sign-in link"));

    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("takes no second press while the first is on its way, and keeps its words", () => {
    const sent = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    render(
      <form onSubmit={sent}>
        <Button pending>Send me a sign-in link</Button>
      </form>,
    );
    const button = screen.getByText("Send me a sign-in link");

    fireEvent.click(button);

    expect(sent).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});
