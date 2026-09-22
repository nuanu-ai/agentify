import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";

import type { BrowserNetworkPolicyError } from "./network-policy.js";
import {
  createPinnedLookup,
  inspectRequest,
  resolvePublicHost,
  resolveSafeNavigationRedirect,
  selectPublicAddress,
  validateActorTarget,
} from "./network-policy.js";

describe("browser network policy", () => {
  it("allows only GET and HEAD", () => {
    expect(
      inspectRequest({
        url: "https://www.example.com/",
        method: "GET",
        isNavigation: true,
        allowedDomain: "example.com",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      inspectRequest({
        url: "https://www.example.com/",
        method: "HEAD",
        isNavigation: false,
        allowedDomain: "example.com",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      inspectRequest({
        url: "https://www.example.com/api",
        method: "POST",
        isNavigation: false,
        allowedDomain: "example.com",
      }),
    ).toEqual({ allowed: false, code: "method_blocked" });
  });

  it("rejects unsafe protocols, ports, credentials and hosts", () => {
    const values = [
      ["file:///etc/passwd", "protocol_blocked"],
      ["https://user:password@example.com/", "credentials_blocked"],
      ["https://example.com:8443/", "port_blocked"],
      ["http://127.0.0.1/", "host_blocked"],
      ["http://2130706433/", "host_blocked"],
      ["http://0x7f000001/", "host_blocked"],
      ["http://169.254.169.254/latest/meta-data/", "host_blocked"],
      ["http://[::1]/", "host_blocked"],
      ["http://service.internal/", "host_blocked"],
    ] as const;
    for (const [url, code] of values) {
      expect(
        inspectRequest({
          url,
          method: "GET",
          isNavigation: false,
          allowedDomain: "example.com",
        }),
      ).toEqual({ allowed: false, code });
    }
  });

  it("keeps top-level navigation same-site and blocks downgrade", () => {
    expect(
      inspectRequest({
        url: "https://cdn.example.net/",
        method: "GET",
        isNavigation: true,
        allowedDomain: "example.com",
      }),
    ).toEqual({ allowed: false, code: "navigation_cross_site" });
    expect(
      inspectRequest({
        url: "http://shop.example.com/",
        method: "GET",
        isNavigation: true,
        allowedDomain: "example.com",
        redirectedFromUrl: "https://www.example.com/",
      }),
    ).toEqual({ allowed: false, code: "redirect_downgrade" });
    expect(
      inspectRequest({
        url: "https://foo.github.io/docs",
        method: "GET",
        isNavigation: true,
        allowedDomain: "foo.github.io",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      inspectRequest({
        url: "https://bar.github.io/docs",
        method: "GET",
        isNavigation: true,
        allowedDomain: "foo.github.io",
      }),
    ).toEqual({ allowed: false, code: "navigation_cross_site" });
  });

  it("allows bounded same-site redirect targets and rejects unsafe redirect targets", () => {
    expect(
      resolveSafeNavigationRedirect({
        allowedDomain: "example.com",
        from: new URL("https://www.example.com/robots.txt"),
        location: "https://example.com/robots.txt",
      }).toString(),
    ).toBe("https://example.com/robots.txt");
    expect(
      resolveSafeNavigationRedirect({
        allowedDomain: "example.com",
        from: new URL("https://www.example.com/robots.txt"),
        location: "/canonical-robots.txt",
      }).toString(),
    ).toBe("https://www.example.com/canonical-robots.txt");
    expect(() =>
      resolveSafeNavigationRedirect({
        allowedDomain: "example.com",
        from: new URL("https://www.example.com/robots.txt"),
        location: "https://example.net/robots.txt",
      }),
    ).toThrow("navigation_cross_site");
    expect(() =>
      resolveSafeNavigationRedirect({
        allowedDomain: "example.com",
        from: new URL("https://www.example.com/robots.txt"),
        location: "http://example.com/robots.txt",
      }),
    ).toThrow("redirect_downgrade");
  });

  it("allows public cross-site subresources without allowing navigation", () => {
    expect(
      inspectRequest({
        url: "https://cdn.example.net/app.js",
        method: "GET",
        isNavigation: false,
        allowedDomain: "example.com",
      }),
    ).toMatchObject({ allowed: true });
  });

  it("validates query-free same-site Actor input", () => {
    expect(
      validateActorTarget({
        canonicalUrl: "https://www.example.com/",
        representativeUrls: ["https://shop.example.com/product"],
        declaredDomain: "example.com",
      }),
    ).toHaveLength(2);
    expect(() =>
      validateActorTarget({
        canonicalUrl: "https://example.com/?token=secret",
        representativeUrls: [],
        declaredDomain: "example.com",
      }),
    ).toThrowError("input_query_or_fragment_blocked");
    expect(() =>
      validateActorTarget({
        canonicalUrl: "https://example.net/",
        representativeUrls: [],
        declaredDomain: "example.com",
      }),
    ).toThrowError("target_blocked");
    expect(() =>
      validateActorTarget({
        canonicalUrl: "https://foo.github.io/",
        representativeUrls: ["https://bar.github.io/docs"],
        declaredDomain: "foo.github.io",
      }),
    ).toThrowError("representative_blocked");
  });

  it("blocks private and metadata addresses before transport", async () => {
    await expect(resolvePublicHost("127.0.0.1")).rejects.toEqual(
      expect.objectContaining<Partial<BrowserNetworkPolicyError>>({
        code: "ssrf_blocked",
      }),
    );
    await expect(resolvePublicHost("169.254.169.254")).rejects.toEqual(
      expect.objectContaining<Partial<BrowserNetworkPolicyError>>({
        code: "ssrf_blocked",
      }),
    );
    await expect(resolvePublicHost("localhost")).rejects.toThrow(
      /ssrf_blocked/,
    );
    expect(() =>
      selectPublicAddress([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.8", family: 4 },
      ]),
    ).toThrow(/ssrf_blocked/);
  });

  it("returns the pinned address for both single and all-address lookups", async () => {
    const lookup = createPinnedLookup({
      address: "93.184.216.34",
      family: 4,
    });
    const single = await new Promise<{
      address: string | LookupAddress[];
      family?: number;
    }>((resolve, reject) => {
      lookup("example.com", { all: false }, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });
    const all = await new Promise<string | LookupAddress[]>(
      (resolve, reject) => {
        lookup("example.com", { all: true }, (error, addresses) => {
          if (error) reject(error);
          else resolve(addresses);
        });
      },
    );

    expect(single).toEqual({ address: "93.184.216.34", family: 4 });
    expect(all).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});
