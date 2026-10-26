/**
 * Where a press's redirect leads, as the browser is told: back to the page it
 * was made on it stays inside the application, so the page is read again in
 * place, and anywhere else the page loads whole.
 */

import { describe, expect, it } from "vitest";
import { sendTo } from "./answer.js";

const RELOAD = "x-remix-reload-document";

describe("a redirect a press answers with", () => {
  it("stays inside the application back to the page it was made on, whatever its query", () => {
    const back = sendTo("/products?q=room&page=2", new URL("http://dashboard.test/products"), "");

    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/products?q=room&page=2");
    expect(back.headers.get(RELOAD)).toBeNull();
  });

  it("hands React Router a path under the dashboard's prefix without the prefix", () => {
    const back = sendTo(
      "/dashboard/products?q=room",
      new URL("http://dashboard.test/dashboard/products"),
      "/dashboard",
    );

    expect(back.headers.get("location")).toBe("/products?q=room");
    expect(back.headers.get(RELOAD)).toBeNull();
  });

  it("loads another page whole, with a query or without", () => {
    const here = new URL("http://dashboard.test/products");

    expect(sendTo("/orders?open=true", here, "").headers.get(RELOAD)).toBe("true");
    expect(sendTo("/settings", here, "").headers.get(RELOAD)).toBe("true");
  });
});
