import { runRetentionCleanup } from "@agentify/scanner-database";

import { getDatabase } from "./database";
import { detachLeadCardSignalsForDeletion } from "./stripe-card-signal";
import type { StripeCardSignalProvider } from "./stripe-card-signal-provider";

export async function executeRetentionCleanup(input: {
  now?: Date;
  batchSize?: number;
  provider?: StripeCardSignalProvider;
}) {
  return await runRetentionCleanup(getDatabase().db, {
    now: input.now ?? new Date(),
    batchSize: input.batchSize,
    beforeLeadAnonymize: async (leadId) => {
      await detachLeadCardSignalsForDeletion(leadId, input.provider);
    },
  });
}
