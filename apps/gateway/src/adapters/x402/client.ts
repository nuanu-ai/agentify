/**
 * Which facilitator client a configuration means, and how it authenticates.
 *
 * The fork is on the facilitator's address, never on whether credentials are
 * set: Coinbase credentials are sent to Coinbase's facilitator and to nothing
 * else, whatever host an environment variable names. Building a client
 * contacts nothing. The start asks Coinbase once whether it takes the key, and
 * a Coinbase that does not answer still cannot stop the gateway from starting.
 */

import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { isCdpFacilitator, type PaymentConfig } from "../../config.js";

/**
 * The calls the client makes, and the method each is made on. A CDP token is
 * good for one method, host and path only, so this must match what
 * `HTTPFacilitatorClient` requests; the names are also the keys the library
 * asks for headers under.
 */
const OPERATIONS = {
  verify: "POST",
  settle: "POST",
  supported: "GET",
} as const;

/**
 * A client that signs every call with Coinbase's credentials, using
 * `@coinbase/cdp-sdk` for the signing. The token names the exact host and path
 * the client will request: the client strips trailing slashes from the base,
 * so this does too, and the host keeps its port as a `Host` header would.
 *
 * The CDP SDK's `Correlation-Context` header is deliberately not sent: it
 * would claim the call comes from that SDK.
 */
export function cdpAuthenticatedClient(
  facilitatorUrl: string,
  apiKeyId: string,
  apiKeySecret: string,
): HTTPFacilitatorClient {
  const { host, pathname } = new URL(facilitatorUrl);
  const basePath = pathname.replace(/\/+$/, "");

  const bearerFor = async (
    operation: keyof typeof OPERATIONS,
  ): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await generateJwt({
      apiKeyId,
      apiKeySecret,
      requestMethod: OPERATIONS[operation],
      requestHost: host,
      requestPath: `${basePath}/${operation}`,
    })}`,
  });

  return new HTTPFacilitatorClient({
    url: facilitatorUrl,
    // Signed per call because each token is good for one request and expires
    // in about two minutes. The library asks for all three at once and picks
    // the one it needs.
    createAuthHeaders: async () => {
      const [verify, settle, supported] = await Promise.all([
        bearerFor("verify"),
        bearerFor("settle"),
        bearerFor("supported"),
      ]);
      return { verify, settle, supported };
    },
  });
}

/**
 * The facilitator client this configuration asks for. The missing-credentials
 * refusal repeats `loadConfig`'s on purpose: without it a client built
 * elsewhere would fail only at the first charge, in front of a buyer.
 */
export function facilitatorClientFor(payment: PaymentConfig): HTTPFacilitatorClient {
  if (!isCdpFacilitator(payment.facilitatorUrl)) {
    return new HTTPFacilitatorClient({ url: payment.facilitatorUrl });
  }

  const { cdpApiKeyId, cdpApiKeySecret } = payment;
  if (cdpApiKeyId === null || cdpApiKeySecret === null) {
    throw new Error(
      `the facilitator at ${payment.facilitatorUrl} takes no request without credentials, and ` +
        "CDP_API_KEY_ID or CDP_API_KEY_SECRET is not set, so there is no client to build",
    );
  }

  return cdpAuthenticatedClient(payment.facilitatorUrl, cdpApiKeyId, cdpApiKeySecret);
}

/**
 * Signs one request locally before the gateway starts selling, and refuses to
 * start if it cannot. A credential that is set but unusable (a truncated
 * secret) would otherwise turn every purchase into "unknown". Nothing is sent
 * to the facilitator; a client without credentials passes.
 *
 * The signer's error is dropped rather than wrapped: a refusal ends up in logs,
 * and only text written here is known not to carry key material.
 */
export async function refuseUnlessCredentialsSign(client: HTTPFacilitatorClient): Promise<void> {
  try {
    await client.createAuthHeaders("verify");
  } catch {
    throw new Error(
      "The gateway cannot start, the facilitator credentials do not work — the key in " +
        "CDP_API_KEY_SECRET is not one this can sign with. Coinbase issues an Ed25519 key as " +
        "base64 and an EC key as a PEM block; a value truncated on the way into the environment " +
        "reads as neither, and the gateway would have started and answered every purchase with " +
        "“nobody knows” instead",
    );
  }
}

const COINBASE_ANSWER_WAIT_MS = 10_000;

/** The line for the log when Coinbase gave no answer about the key, saying why. */
const unconfirmed = (why: string): string =>
  `the key in CDP_API_KEY_ID and CDP_API_KEY_SECRET is unconfirmed — Coinbase could not say ` +
  `whether it takes it (${why}), which says nothing about the key either way. The gateway starts ` +
  "without knowing, and a key Coinbase refuses would show only at the first purchase, which " +
  "would fail at verify";

/**
 * Makes the credentials sign, as `refuseUnlessCredentialsSign` does, and then
 * shows the key to Coinbase once: its facilitator is asked to verify an empty
 * payment with the token a purchase's verify would carry. A 400 is what
 * Coinbase was seen to answer a key it lets through, judging the payment
 * instead; a 2xx or 422 is counted with it, as an answer given past the key
 * check, though neither has been seen. All three bring null back. A 401 or
 * 403 is Coinbase refusing the key itself, and this throws, naming the two
 * variables and the likely causes. Any other status, no connection or no
 * answer within ten seconds says nothing about the key, and somebody else's
 * outage must not stop a storefront: what comes back then is the one line to
 * log saying the key is unconfirmed. A facilitator that is not Coinbase's is
 * asked nothing, and null comes back.
 *
 * Neither the token, nor Coinbase's answer, nor what fetch threw reaches what
 * this throws or returns, and a redirect is not followed with the token.
 */
export async function refuseUnlessCoinbaseTakesTheKey(
  client: HTTPFacilitatorClient,
  post: typeof fetch,
): Promise<string | null> {
  await refuseUnlessCredentialsSign(client);
  if (!isCdpFacilitator(client.url)) {
    return null;
  }
  const { headers } = await client.createAuthHeaders("verify");

  let status: number;
  try {
    const response = await post(`${client.url}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ x402Version: 2 }),
      redirect: "manual",
      signal: AbortSignal.timeout(COINBASE_ANSWER_WAIT_MS),
    });
    // Nothing reads the body; cancelling it frees the connection.
    response.body?.cancel().catch(() => undefined);
    status = response.status;
  } catch (thrown) {
    const name = thrown instanceof Error ? thrown.name : "";
    return unconfirmed(
      name === "TimeoutError"
        ? `no answer within ${COINBASE_ANSWER_WAIT_MS / 1_000} seconds`
        : "no connection",
    );
  }

  if (status === 401 || status === 403) {
    throw new Error(
      "The gateway cannot start, Coinbase refuses the facilitator credentials — asked to verify " +
        "an empty payment with the key CDP_API_KEY_ID names, signed with CDP_API_KEY_SECRET, it " +
        `answered HTTP ${status}. Likely causes, though the answer does not say which: the key ` +
        "was revoked or deleted; the key has an IP allowlist that does not include this server's " +
        "public address; the account or the project the key belongs to is restricted; or this " +
        "host's clock is off by more than about two minutes, so that every token Coinbase " +
        "receives looks expired or not yet valid. Started anyway, the gateway would take " +
        "purchases and fail every one of them at verify",
    );
  }
  if ((status >= 200 && status < 300) || status === 400 || status === 422) {
    return null;
  }
  return unconfirmed(`HTTP ${status}`);
}
