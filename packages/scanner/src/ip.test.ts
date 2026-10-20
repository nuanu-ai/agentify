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
    ["2001:2::1", "benchmark"],
    ["::ffff:127.0.0.1", "loopback"],
  ])("blocks %s", (address, reason) => {
    expect(classifyIp(address)).toMatchObject({ allowed: false, reason });
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2001:200::1",
    "::ffff:8.8.8.8",
  ])("allows public unicast %s", (address) =>
    expect(classifyIp(address)).toMatchObject({ allowed: true }),
  );

  it.each([
    ["64:ff9b::a00:1", "private"],
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link_local"],
  ])("a NAT64 address of a non-public IPv4 host is refused: %s", (address, reason) =>
    expect(classifyIp(address)).toMatchObject({ allowed: false, reason }),
  );

  it("a NAT64 address of a public IPv4 host is reached, as an IPv6-only network reaches it", () =>
    expect(classifyIp("64:ff9b::808:808")).toMatchObject({ allowed: true }));

  it("a local-use NAT64 address is refused, since the IPv4 host it reaches is the network's choice", () =>
    expect(classifyIp("64:ff9b:1::a00:1")).toMatchObject({ allowed: false, reason: "reserved" }));

  it.each([
    ["2002:a00:1::1", "private"],
    ["2002:7f00:1::", "loopback"],
    ["2002:c0a8:101::1", "private"],
  ])("a 6to4 address of a non-public IPv4 host is refused: %s", (address, reason) =>
    expect(classifyIp(address)).toMatchObject({ allowed: false, reason }),
  );

  it.each(["::127.0.0.1", "::a00:1", "::8.8.8.8"])(
    "an IPv4-compatible address is refused whatever it carries: %s",
    (address) => expect(classifyIp(address)).toMatchObject({ allowed: false, reason: "reserved" }),
  );

  it.each([
    ["fec0::1", "deprecated site-local"],
    ["100::1", "discard-only"],
    ["5f00::1", "segment routing"],
    ["::ffff:0:a00:1", "IPv4-translated"],
    ["4000::1", "unassigned"],
  ])("an address outside the global unicast space is refused: %s (%s)", (address) =>
    expect(classifyIp(address)).toMatchObject({ allowed: false, reason: "reserved" }),
  );

  it.each([
    ["2001::1", "Teredo"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "Teredo"],
    ["2001:10::1", "ORCHID"],
    ["2001:20::1", "ORCHIDv2"],
    ["2001:1::1", "anycast relay"],
    ["2001:3::1", "AMT relay"],
    ["2001:4:112::1", "AS112 sink"],
    ["2001:30::1", "drone identifier"],
    ["2001:1ff::1", "unassigned"],
  ])("an address of the IETF protocol block is refused: %s (%s)", (address) =>
    expect(classifyIp(address)).toMatchObject({ allowed: false, reason: "reserved" }),
  );

  it.each(["2001:db8::1", "3fff::1", "3fff:fff::1"])(
    "an IPv6 documentation address is refused: %s",
    (address) =>
      expect(classifyIp(address)).toMatchObject({ allowed: false, reason: "documentation" }),
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
    "https://shop/",
    "shop.",
    "https://example.local/",
    "https://shop.localhost./",
    "https://example.local./",
    "https://a.internal./",
    "https://example.com:8080/",
    "https://example.com/?access_token=secret",
    "https://example.com/?signature=x",
    // A name with an underscore is no public website's: Docker's own DNS
    // answers such names for the containers beside the scanner.
    "https://postgres.agentify_default/",
    "https://db_1.example.com/",
  ])("rejects unsafe target %s", (target) => expect(() => canonicalizeTarget(target)).toThrow());

  it("blocks HTTPS downgrade redirects", () => {
    expect(() => validateRedirect(new URL("https://example.com/"), "http://example.com/")).toThrow(
      "redirect_downgrade_blocked",
    );
  });
});
