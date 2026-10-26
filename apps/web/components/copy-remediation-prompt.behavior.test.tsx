// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyRemediationPrompt } from "./copy-remediation-prompt";

/** A browser that refuses the page its clipboard, as one does where permission is denied. */
const refusingClipboard = () =>
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
  });

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
  cleanup();
});

describe("copying where the clipboard is refused", () => {
  it("selects the whole text for copying by hand and then says it is selected", async () => {
    refusingClipboard();
    render(<CopyRemediationPrompt label="Copy this fix" prompt="Add Product JSON-LD." />);

    await userEvent.click(screen.getByRole("button", { name: "Copy this fix" }));

    const box = (await screen.findByRole("textbox", { name: "Fix prompt" })) as HTMLTextAreaElement;
    await screen.findByText(/fix prompt is selected below/i);
    expect(document.activeElement).toBe(box);
    expect(box.value.slice(box.selectionStart, box.selectionEnd)).toBe("Add Product JSON-LD.");
  });

  it("does not say the text is selected when the browser did not select it", async () => {
    refusingClipboard();
    vi.spyOn(HTMLTextAreaElement.prototype, "select").mockImplementation(() => {});
    render(<CopyRemediationPrompt label="Copy this fix" prompt="Add Product JSON-LD." />);

    await userEvent.click(screen.getByRole("button", { name: "Copy this fix" }));

    await screen.findByRole("textbox", { name: "Fix prompt" });
    expect(await screen.findByText(/copy the fix prompt from the box below/i)).toBeTruthy();
    expect(screen.queryByText(/selected/i)).toBeNull();
  });

  it("calls the developer brief a brief, in its words and at its box", async () => {
    refusingClipboard();
    render(
      <CopyRemediationPrompt
        label="Copy developer brief"
        prompt="Brief for the developer."
        subject="developer brief"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Copy developer brief" }));

    await screen.findByRole("textbox", { name: "Developer brief" });
    const told = await screen.findByText(/developer brief is selected below/i);
    expect(told.textContent).not.toMatch(/prompt/i);
  });
});
