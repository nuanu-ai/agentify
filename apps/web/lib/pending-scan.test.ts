import { describe, expect, it } from "vitest";

import {
  clearPendingScan,
  PENDING_SCAN_STORAGE_KEY,
  type PendingScanRequest,
  readPendingScan,
  savePendingScan,
} from "./pending-scan";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const request: PendingScanRequest = {
  url: "example.com",
  segment: "owner",
  variant: "owner-v1",
  idempotencyKey: "018f3f56-2ec8-7b16-8f66-5b8f93f3251f",
  landingPath: "/owner",
  landingSearch: "?utm_source=test",
};

describe("pending scan browser handoff", () => {
  it("persists an idempotent scan start across the route transition", () => {
    const storage = new MemoryStorage();
    savePendingScan(storage, request);
    expect(readPendingScan(storage)).toEqual(request);
  });

  it("fails closed and removes malformed browser state", () => {
    const storage = new MemoryStorage();
    storage.setItem(PENDING_SCAN_STORAGE_KEY, '{"url":"javascript:alert(1)"}');
    expect(readPendingScan(storage)).toBeNull();
    expect(storage.getItem(PENDING_SCAN_STORAGE_KEY)).toBeNull();
  });

  it("keeps the address it was given without the spaces around it", () => {
    const storage = new MemoryStorage();
    savePendingScan(storage, { ...request, url: "  example.com  " });
    expect(readPendingScan(storage)?.url).toBe("example.com");
  });

  it.each([
    ["a segment the product does not know", { segment: "wholesale" }],
    ["an empty address", { url: "   " }],
    ["an address longer than a scan takes", { url: `example.com/${"a".repeat(2048)}` }],
    ["no variant", { variant: "" }],
    ["an idempotency key too short to be one", { idempotencyKey: "short" }],
    ["a landing path that is not a path", { landingPath: "https://elsewhere.example/" }],
    ["a field the hand-off never writes", { extra: "x" }],
    ["a field of the wrong kind", { landingSearch: 5 }],
  ])("refuses to keep a request with %s, and reads none back", (_case, change) => {
    const storage = new MemoryStorage();
    expect(() =>
      savePendingScan(storage, { ...request, ...change } as PendingScanRequest),
    ).toThrow();
    storage.setItem(PENDING_SCAN_STORAGE_KEY, JSON.stringify({ ...request, ...change }));
    expect(readPendingScan(storage)).toBeNull();
    expect(storage.getItem(PENDING_SCAN_STORAGE_KEY)).toBeNull();
  });

  it("clears the request after the server accepts it", () => {
    const storage = new MemoryStorage();
    savePendingScan(storage, request);
    clearPendingScan(storage);
    expect(readPendingScan(storage)).toBeNull();
  });
});
