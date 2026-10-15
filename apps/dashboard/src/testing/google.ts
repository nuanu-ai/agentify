import { createHash, randomUUID } from "node:crypto";

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  hd?: string;
}

/** Exercises the stock provider's code exchange without leaving the process. */
export function googleExchange() {
  const codes = new Map<string, { challenge: string; redirect: string; profile: GoogleProfile }>();
  const issuedTokens: string[] = [];
  let unavailable = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://oauth2.googleapis.com/token") {
      throw new Error(`Unexpected Google request: ${url}`);
    }
    if (unavailable) throw new Error("Google is unreachable");
    const body = new URLSearchParams(String(init?.body));
    const code = body.get("code") ?? "";
    const flow = codes.get(code);
    codes.delete(code);
    const challenge = createHash("sha256")
      .update(body.get("code_verifier") ?? "")
      .digest("base64url");
    if (!flow || challenge !== flow.challenge || body.get("redirect_uri") !== flow.redirect) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const idToken = [
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "offline-google" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({
          ...flow.profile,
          iss: "https://accounts.google.com",
          aud: "offline-client",
        }),
      ).toString("base64url"),
      "offline-signature",
    ].join(".");
    const accessToken = `offline-access-${randomUUID()}`;
    const refreshToken = `offline-refresh-${randomUUID()}`;
    issuedTokens.push(idToken, accessToken, refreshToken);
    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      expires_in: 3600,
      token_type: "Bearer",
      scope: "openid email profile",
    });
  };
  return {
    fetch,
    issuedTokens,
    goOffline() {
      unavailable = true;
    },
    authorize(location: string, profile: Partial<GoogleProfile> = {}) {
      const url = new URL(location);
      if (url.origin !== "https://accounts.google.com" || !url.searchParams.get("code_challenge")) {
        throw new Error("Google authorization must use state and PKCE");
      }
      const code = randomUUID();
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirect: url.searchParams.get("redirect_uri") ?? "",
        profile: {
          sub: "google-subject",
          email: "person@gmail.com",
          email_verified: true,
          name: "Personal Google Name",
          ...profile,
        },
      });
      return new URLSearchParams({ code, state: url.searchParams.get("state") ?? "" });
    },
  };
}

export function cookieHeader(lines: readonly string[]): string {
  return lines.map((line) => line.split(";", 1)[0]).join("; ");
}
