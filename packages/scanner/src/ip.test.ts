import { describe, expect, it } from "vitest";
import { assertPublicAddresses, classifyIp } from "./ip.js";
import { canonicalizeTarget, validateRedirect } from "./url.js";

describe("IP and URL SSRF policy", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["100.100.100.200", "carrier_grade_nat"],
    ["169.254.169.254", "link_local"],
    ["192.0.2.1", "documentation"],
    ["198.19.0.1", "benchmark"],
    ["224.0.0.1", "multicast"],
    ["::1", "loopback"],
    ["fe80::1", "link_local"],
    ["fc00::1", "private"],
    ["2001:db8::1", "documentation"],
    ["::ffff:127.0.0.1", "loopback"],
  ])("blocks %s", (address, reason) => {
    expect(classifyIp(address)).toMatchObject({ allowed: false, reason });
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "allows public unicast %s",
    (address) => expect(classifyIp(address)).toMatchObject({ allowed: true }),
  );

  it("rejects mixed public/private DNS answers", () => {
    expect(() => assertPublicAddresses(["8.8.8.8", "10.0.0.1"])).toThrow("ssrf_blocked:private");
  });

  it("canonicalizes and redacts tracking parameters", () => {
    expect(canonicalizeTarget("Example.COM/path?utm_source=x&ok=1#frag").toString()).toBe(
      "https://example.com/path?ok=1",
    );
  });

  it.each([
    "file:///etc/passwd",
    "https://user:pass@example.com/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://localhost/",
    "https://example.local/",
    "https://example.com:8080/",
    "https://example.com/?access_token=secret",
    "https://example.com/?signature=x",
  ])("rejects unsafe target %s", (target) => expect(() => canonicalizeTarget(target)).toThrow());

  it("blocks HTTPS downgrade redirects", () => {
    expect(() => validateRedirect(new URL("https://example.com/"), "http://example.com/")).toThrow(
      "redirect_downgrade_blocked",
    );
  });
});
