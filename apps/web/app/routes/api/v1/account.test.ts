/**
 * A signed-in person's requests about the data filed under their address,
 * asked of the whole process over HTTP: a copy or a deletion, and an end to
 * email. Whose session it is and what is filed under the address are the
 * dashboard's and the database's to say; what is refused before either, and
 * when the dashboard does not answer, is here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowedAt,
  fromSite,
  refusalOf,
  SIGNED_IN,
  stubOfflineScanner,
} from "../../../../testing/api";
import { ask } from "../../../../testing/scanner";

beforeEach(stubOfflineScanner);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ROUTES = [
  [
    "a data request",
    "/api/v1/account/data-request",
    { type: "access", signed_in_as: "person@example.com" },
  ],
  ["an unsubscription", "/api/v1/account/unsubscribe", { signed_in_as: "person@example.com" }],
] as const;

describe.each(ROUTES)("%s", (_what, path, body) => {
  it("is refused when it comes from another origin", async () => {
    const answered = await fromSite(path, "POST", body, {
      origin: "https://elsewhere.example",
      cookie: SIGNED_IN,
    });

    expect(answered.status).toBe(403);
    expect((await refusalOf(answered)).code).toBe("invalid_origin");
  });

  it("asks a visitor who is not signed in to sign in first", async () => {
    const answered = await fromSite(path, "POST", body);

    expect(answered.status).toBe(404);
    expect(await refusalOf(answered)).toMatchObject({
      code: "session_not_found",
      message: "Sign in with the address your reports were sent to before making this request.",
    });
  });

  it("changes nothing, and says so, where the dashboard does not answer", async () => {
    const answered = await fromSite(path, "POST", body, { cookie: SIGNED_IN });

    expect(answered.status).toBe(503);
    expect(await refusalOf(answered)).toMatchObject({
      code: "visitor_unknown",
      message:
        "We cannot tell who is visiting right now, so nothing was changed. Try again shortly.",
      retryable: true,
      retry_after_seconds: 30,
    });
  });

  it("takes a post alone", async () => {
    expect((await ask(path)).status).toBe(405);
    expect(await allowedAt(path)).toBe("OPTIONS, POST");
  });
});
