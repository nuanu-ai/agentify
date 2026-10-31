import { sql } from "drizzle-orm";

/** Pending request projection shared by queue and merchant readers; `r` is their joined request. */
export const pendingRequest = sql`case when r.id is null then null else jsonb_build_object(
  'id', r.id, 'merchantId', r.merchant_id, 'accountId', r.account_id,
  'requestedAt', floor(extract(epoch from r.requested_at) * 1000)::float8,
  'evidence', r.evidence, 'state', r.state, 'decline', null,
  'reminderDueAt', floor(extract(epoch from r.reminder_due_at) * 1000)::float8,
  'reminderCreatedAt', floor(extract(epoch from r.reminder_created_at) * 1000)::float8
) end`;
