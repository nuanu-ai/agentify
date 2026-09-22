import { afterEach, describe, expect, it, vi } from "vitest";

import { captureLandingAttribution, readPartnerClickId } from "./attribution-client";

afterEach(() => vi.unstubAllGlobals());

describe("partner click attribution", () => {
  it.each(["clickid", "click_id", "cid", "sub_id", "subid"])("accepts the %s alias", (alias) => {
    expect(readPartnerClickId(`?${alias}=Xk8sJ2QpR4vN7bL0aZ9wQg`)).toBe("Xk8sJ2QpR4vN7bL0aZ9wQg");
  });

  it("uses the first non-empty alias and rejects invalid values", () => {
    expect(readPartnerClickId("?clickid=&clickid=Xk8sJ2QpR4vN7bL0aZ9wQg&click_id=ignored")).toBe(
      "Xk8sJ2QpR4vN7bL0aZ9wQg",
    );
    expect(readPartnerClickId("?clickid=short&click_id=Xk8sJ2QpR4vN7bL0aZ9wQg")).toBeUndefined();
    expect(readPartnerClickId("?clickid=Xk8sJ2QpR4vN7bL0aZ9wQg%2B")).toBeUndefined();
  });

  it("retries a transient attribution failure on the next capture", async () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null },
    });
    const provider = { attempts: 0, accepted: false };
    const fetcher = async () => {
      provider.attempts += 1;
      if (provider.attempts === 1) {
        return new Response(null, { status: 503 });
      }
      provider.accepted = true;
      return new Response(null, { status: 204 });
    };
    vi.stubGlobal("fetch", fetcher);
    const source = {
      pathname: "/",
      search: "?utm_campaign=retry-test",
    };

    await captureLandingAttribution("owner", "owner-retry-test", source);
    await captureLandingAttribution("owner", "owner-retry-test", source);

    expect(provider).toEqual({ attempts: 2, accepted: true });
  });
});
