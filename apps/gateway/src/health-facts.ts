/**
 * What Health reads from the running gateway itself rather than from its
 * records: the source revision the build wrote into the image, whether payment
 * recovery reads the chain and from which host, and the window the purchase
 * guard waits for a seller's process. An RPC address can carry the provider's
 * key in its path or query, so only its host leaves here.
 */

import type { SurfaceMode } from "@agentify/core";
import { SILENT_AFTER_MS } from "@agentify/core/published";
import { CONTACT_WRITTEN_EVERY_MS } from "./app/gateway.js";
import type { GatewayConfig } from "./config.js";

export interface GatewayHealthFacts {
  readonly surface: SurfaceMode;
  /** The CAIP-2 chain the channel takes payments on. */
  readonly network: string;
  /** The commit the image was built from, or null where the build wrote none, as on a laptop. */
  readonly revision: string | null;
  /** Payment recovery: off where no chain endpoint is configured, otherwise the host it reads. */
  readonly recovery:
    | { readonly configured: false }
    | { readonly configured: true; readonly host: string };
  /** How long a seller's process may go without polling before their purchases are refused. */
  readonly workerWindowMs: number;
}

/** The variable the image's build writes the source revision into. */
const REVISION = "AGENTIFY_SOURCE_REVISION";

/** The value a build that was given no revision writes. */
const NO_REVISION = "unknown";

export function gatewayHealthFacts(
  config: Pick<GatewayConfig, "surfaceMode" | "payment">,
  environment: Readonly<Record<string, string | undefined>>,
): GatewayHealthFacts {
  const revision = environment[REVISION]?.trim() ?? "";
  const { rpcUrl } = config.payment;
  return {
    surface: config.surfaceMode,
    network: config.payment.network,
    revision: revision === "" || revision === NO_REVISION ? null : revision,
    recovery:
      rpcUrl === undefined
        ? { configured: false }
        : { configured: true, host: new URL(rpcUrl).host },
    workerWindowMs: SILENT_AFTER_MS + CONTACT_WRITTEN_EVERY_MS,
  };
}
