// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Table } from "./table.js";

afterEach(cleanup);

describe("a table", () => {
  it("gives every value the head of its column, which is its label where rows become blocks", () => {
    const { container } = render(
      <Table
        columns={["Order", "Amount", ""]}
        rows={[
          {
            key: "ord_1",
            cells: [{ content: "ord_1" }, { content: "80.00 USD" }, { content: "Pause" }],
          },
        ]}
        empty="No orders yet."
      />,
    );
    const cells = [...container.querySelectorAll("tbody td")];

    expect(cells.map((cell) => cell.getAttribute("data-label"))).toEqual([
      "Order",
      "Amount",
      // A column with no head draws no empty label.
      null,
    ]);
    expect(cells.map((cell) => cell.textContent)).toEqual(["ord_1", "80.00 USD", "Pause"]);
  });

  it("says what its caller says when there are no rows, and draws no empty table", () => {
    const { container } = render(
      <Table columns={["Order", "Amount"]} rows={[]} empty="No orders yet." />,
    );

    expect(container.textContent).toBe("No orders yet.");
    expect(container.querySelector("table")).toBeNull();
  });
});
