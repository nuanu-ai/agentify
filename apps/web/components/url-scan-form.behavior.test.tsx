// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readPendingScan } from "../lib/pending-scan";
import { UrlScanForm } from "./url-scan-form";

const navigation = vi.hoisted(() => ({
  prefetched: new Set<string>(),
  route: null as string | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    prefetch: (route: string) => navigation.prefetched.add(route),
    push: (route: string) => {
      navigation.route = route;
    },
  }),
}));

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

const originalSessionStorage = Object.getOwnPropertyDescriptor(
  window,
  "sessionStorage",
);

function installStorage(storage: Storage) {
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: storage,
  });
}

describe("landing scan handoff", () => {
  beforeEach(() => {
    Object.assign(globalThis, { React });
    navigation.prefetched.clear();
    navigation.route = null;
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
    render(<UrlScanForm cta="Scan" segment="owner" variant="owner-v1" />);

    await user.type(
      screen.getByRole("textbox", { name: "Website URL" }),
      "http://localhost",
    );
    await user.click(screen.getByRole("button", { name: /scan/i }));

    expect(readPendingScan(window.sessionStorage)).toBeNull();
    expect(navigation.route).toBeNull();
    expect(
      document.querySelector('[aria-live="polite"]')?.textContent,
    ).not.toBe("");
  });

  it("stores a schema-valid request before moving to the private pending route", async () => {
    const user = userEvent.setup();
    render(<UrlScanForm cta="Scan" segment="owner" variant="owner-v1" />);

    await user.type(
      screen.getByRole("textbox", { name: "Website URL" }),
      "example.com",
    );
    await user.click(screen.getByRole("button", { name: /scan/i }));

    await waitFor(() =>
      expect(navigation.route).toBe("/scan/pending?segment=owner"),
    );
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
    render(<UrlScanForm cta="Scan" segment="owner" variant="owner-v1" />);

    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Website URL",
    });
    await user.type(input, "example.com");
    await user.click(screen.getByRole("button", { name: /scan/i }));

    expect(readPendingScan(storage)).toBeNull();
    expect(navigation.route).toBeNull();
    expect(input.disabled).toBe(false);
    expect(
      document.querySelector('[aria-live="polite"]')?.textContent,
    ).not.toBe("");
  });
});
