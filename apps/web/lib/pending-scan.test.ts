import { describe, expect, it } from "vitest";

import {
  PENDING_SCAN_STORAGE_KEY,
  clearPendingScan,
  readPendingScan,
  savePendingScan,
  type PendingScanRequest,
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

  it("clears the request after the server accepts it", () => {
    const storage = new MemoryStorage();
    savePendingScan(storage, request);
    clearPendingScan(storage);
    expect(readPendingScan(storage)).toBeNull();
  });
});
