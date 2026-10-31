import type { SetupResult } from "./events.js";

export const liveSalesResult = (
  step: "live_request" | "live_decline",
  merchant: string,
  integration: "api" | "woocommerce" | "none",
  person?: string,
): SetupResult =>
  ({
    name: "agc_setup_result",
    actor: step === "live_request" ? "human" : "operator",
    source: "dashboard",
    refs: { merchant, ...(step === "live_request" && person ? { person } : {}) },
    fields: { step, integration, outcome: "completed" },
  }) as SetupResult;

/** The same step a seller name saved in Settings counts, for a name the request writes. */
export const sellerNameNamed = (merchant: string): SetupResult =>
  ({
    name: "agc_setup_result",
    actor: "human",
    source: "dashboard",
    refs: { merchant },
    fields: { step: "seller_name", integration: "none", outcome: "completed" },
  }) as SetupResult;
