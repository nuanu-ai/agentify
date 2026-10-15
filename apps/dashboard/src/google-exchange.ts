import { authorizationCodeRequest, type BetterAuthPlugin, getOAuth2Tokens } from "better-auth";

const tokenEndpoint = "https://oauth2.googleapis.com/token";

/** Bound the network wait while the callback owns its database transaction. */
export function boundedGoogleExchange(): BetterAuthPlugin {
  return {
    id: "dashboard-google-exchange",
    init({ socialProviders }) {
      return {
        context: {
          socialProviders: socialProviders.map((provider) =>
            provider.id !== "google"
              ? provider
              : {
                  ...provider,
                  async validateAuthorizationCode({ code, codeVerifier, redirectURI }) {
                    const request = await authorizationCodeRequest({
                      code,
                      codeVerifier,
                      redirectURI,
                      options: provider.options ?? {},
                      tokenEndpoint,
                    });
                    // The same signal covers headers and the complete body. A
                    // headers-only timeout still leaves a stalled body holding a connection.
                    const response = await fetch(tokenEndpoint, {
                      ...request,
                      method: "POST",
                      redirect: "error",
                      signal: AbortSignal.timeout(10_000),
                    });
                    if (!response.ok) {
                      await response.body?.cancel();
                      throw new Error("google_token_exchange_failed");
                    }
                    const tokens: unknown = await response.json();
                    if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
                      throw new Error("google_token_exchange_failed");
                    }
                    return getOAuth2Tokens(tokens);
                  },
                },
          ),
        },
      };
    },
  };
}
