// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, expect, it } from "vitest";
import { NO_REASON } from "../../../src/admin/words.js";
import { ActionForm } from "./action-form.js";

afterEach(cleanup);

it("keeps note-writing guidance before the refusal and reads both with the retained, required note", () => {
  const hint = "Explain the change the merchant should make.";
  const refusal = "A note is required to decline the request.";
  const Stub = createRoutesStub([
    {
      id: "routes/gate",
      path: "/",
      Component: () => (
        <ActionForm
          action="/decline"
          page="/"
          button="Decline"
          consequence="The merchant reads the note."
          reason
          reasonWords={{ label: "Note", hint, missing: refusal }}
          fields={{ request_id: "req_123" }}
          answer={{ kind: "refused", field: "reason", said: NO_REASON, typed: "  " }}
        />
      ),
    },
  ]);
  render(
    <Stub
      initialEntries={["/"]}
      hydrationData={{ loaderData: { "routes/gate": { who: "operator@example.com" } } }}
    />,
  );

  const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Note" });
  const description = (box.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id));
  expect(description.map((line) => line?.textContent)).toEqual([hint, refusal]);
  expect(
    (description[0]?.compareDocumentPosition(description[1] as Node) ?? 0) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(box.value).toBe("  ");
  expect(box.required).toBe(true);
  expect(box.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(box);
  const form = box.form;
  expect(form).not.toBeNull();
  const carried = new FormData(form as HTMLFormElement);
  expect(carried.get("request_id")).toBe("req_123");
  const confirmation = screen.getByRole<HTMLInputElement>("checkbox");
  expect(confirmation.required).toBe(true);
  expect(confirmation.checked).toBe(false);
});
