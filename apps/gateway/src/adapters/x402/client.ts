/**
 * Which facilitator client a configuration means, and how it authenticates.
 *
 * The fork is on the facilitator's address, never on whether credentials are
 * set: Coinbase credentials are sent to Coinbase's facilitator and to nothing
 * else, whatever host an environment variable names. Building a client
 * contacts nothing, so an unreachable facilitator cannot stop the gateway from
 * starting.
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
