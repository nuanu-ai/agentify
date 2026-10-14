// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readPendingScan } from "../lib/pending-scan";
import { siteRouter } from "../testing/on-site";
import { UrlScanForm } from "./url-scan-form";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

/** The form on the landing a visitor arrived at, and where the router has them now. */
function landing() {
  const router = siteRouter(<UrlScanForm cta="Scan" segment="owner" variant="owner-v1" />, {
    at: "/owner?utm_source=behavior-test",
  });
  render(<RouterProvider router={router} />);
  return { at: () => `${router.state.location.pathname}${router.state.location.search}` };
}

const originalSessionStorage = Object.getOwnPropertyDescriptor(window, "sessionStorage");

function installStorage(storage: Storage) {
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: storage,
  });
}

describe("landing scan handoff", () => {
  beforeEach(() => {
    Object.assign(globalThis, { React });
    installStorage(new MemoryStorage());
    window.history.replaceState({}, "", "/owner?utm_source=behavior-test");
    globalThis.fetch = async () => new Response(null, { status: 201 });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (originalSessionStorage) {
      Object.defineProperty(window, "sessionStorage", originalSessionStorage);
    }
  });

  it("refuses an invalid URL without creating a pending request or changing route", async () => {
    const user = userEvent.setup();
    const visit = landing();

    await user.type(screen.getByRole("textbox", { name: "Website URL" }), "http://localhost");
    await user.click(screen.getByRole("button", { name: /scan/i }));

    expect(readPendingScan(window.sessionStorage)).toBeNull();
    expect(visit.at()).toBe("/owner?utm_source=behavior-test");
    expect(document.querySelector('[aria-live="polite"]')?.textContent).not.toBe("");
  });

  it("keeps the request where the pending page reads it, before moving to the private pending route", async () => {
    const user = userEvent.setup();
    const visit = landing();

    await user.type(screen.getByRole("textbox", { name: "Website URL" }), "example.com");
    await user.click(screen.getByRole("button", { name: /scan/i }));

    await waitFor(() => expect(visit.at()).toBe("/scan/pending?segment=owner"));
    expect(readPendingScan(window.sessionStorage)).toMatchObject({
      url: "example.com",
      segment: "owner",
      variant: "owner-v1",
      landingPath: "/owner",
      landingSearch: "?utm_source=behavior-test",
    });
  });

  it("stays on the form when private storage is blocked", async () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    installStorage(storage);
    const user = userEvent.setup();
    const visit = landing();

    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Website URL",
    });
    await user.type(input, "example.com");
    await user.click(screen.getByRole("button", { name: /scan/i }));

    expect(readPendingScan(storage)).toBeNull();
    expect(visit.at()).toBe("/owner?utm_source=behavior-test");
    expect(input.disabled).toBe(false);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).not.toBe("");
  });
});
