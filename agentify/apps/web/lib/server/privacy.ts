import {
  anonymizeLeadData,
  leads,
  runRetentionCleanup,
  UNVERIFIED_LEAD_RETENTION_MS,
} from "@b2a/db";
import { eq } from "drizzle-orm";

import { getDatabase } from "./database";
import { detachLeadCardSignalsForDeletion } from "./stripe-card-signal";
import type { StripeCardSignalProvider } from "./stripe-card-signal-provider";
import {
  getSupabaseAuthAdminProvider,
  type SupabaseAuthAdminProvider,
} from "./supabase-auth";

async function deleteLinkedSupabaseUser(
  leadId: string,
  provider = getSupabaseAuthAdminProvider(),
) {
  const linked = (
    await getDatabase()
      .db.select({ supabaseUserId: leads.supabaseUserId })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1)
  )[0];
  if (!linked?.supabaseUserId) return { status: "not_linked" as const };
  if (!provider) throw new Error("supabase_auth_admin_unavailable");
  await provider.deleteUser(linked.supabaseUserId);
  return { status: "deleted" as const };
}

export async function completeLeadDeletion(input: {
  leadId: string;
  provider?: StripeCardSignalProvider;
  supabaseProvider?: SupabaseAuthAdminProvider;
  now?: Date;
}) {
  const providerResult = await detachLeadCardSignalsForDeletion(
    input.leadId,
    input.provider,
  );
  const supabaseResult = await deleteLinkedSupabaseUser(
    input.leadId,
    input.supabaseProvider,
  );
  const databaseResult = await anonymizeLeadData(
    getDatabase().db,
    input.leadId,
    input.now,
  );
  if (databaseResult.status === "not_found")
    throw new Error("lead_deletion_target_missing");
  return {
    provider: providerResult,
    supabase: supabaseResult,
    database: databaseResult,
  } as const;
}

export async function executeRetentionCleanup(input: {
  now?: Date;
  batchSize?: number;
  provider?: StripeCardSignalProvider;
  supabaseProvider?: SupabaseAuthAdminProvider;
}) {
  const now = input.now ?? new Date();
  const supabaseProvider =
    input.supabaseProvider ?? getSupabaseAuthAdminProvider();
  if (process.env.NODE_ENV === "production" && !supabaseProvider) {
    throw new Error("supabase_auth_admin_required_for_privacy_cleanup");
  }
  const staleSupabaseCutoff = new Date(
    now.getTime() - UNVERIFIED_LEAD_RETENTION_MS,
  );
  const staleSupabaseUserIds = supabaseProvider
    ? await supabaseProvider.listStaleUnconfirmedUserIds(
        staleSupabaseCutoff,
        input.batchSize ?? 100,
      )
    : [];
  let supabaseUsersDeleted = 0;
  for (const userId of staleSupabaseUserIds) {
    if (
      await supabaseProvider?.deleteUserIfStillStale(
        userId,
        staleSupabaseCutoff,
      )
    ) {
      supabaseUsersDeleted += 1;
    }
  }
  const database = await runRetentionCleanup(getDatabase().db, {
    now,
    batchSize: input.batchSize,
    beforeLeadAnonymize: async (leadId) => {
      await detachLeadCardSignalsForDeletion(leadId, input.provider);
      await deleteLinkedSupabaseUser(leadId, supabaseProvider);
    },
  });
  return {
    ...database,
    supabaseUsersDeleted,
  };
}
