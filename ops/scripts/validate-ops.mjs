import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const dashboards = new URL("../dashboards/", import.meta.url).pathname;
const files = (await readdir(dashboards)).filter((name) =>
  name.endsWith(".sql"),
);
const aggregateFiles = files.filter(
  (name) => !name.endsWith(".restricted.sql"),
);
const forbiddenAggregateFields = [
  "email_normalized_ciphertext",
  "email_lookup_hash",
  "phone_e164_ciphertext",
  "phone_lookup_hash",
  "callback_state_hash",
  "supabase_user_id",
  "token_hash",
  "session_token_hash",
  "access_token_hash",
  "idempotency_key_hash",
  "pain_answer",
  "payment_method_id_ciphertext",
  "stripe_customer_id",
  "setup_intent_id",
  "provider_event_id",
  "public_snapshot",
  "canonical_target_url",
  "submitted_url_redacted",
];

const failures = [];
for (const name of aggregateFiles) {
  const sql = (await readFile(join(dashboards, name), "utf8")).toLowerCase();
  if (!sql.trim().endsWith(";"))
    failures.push(`${name}: SQL must end with semicolon`);
  for (const field of forbiddenAggregateFields) {
    if (sql.includes(field))
      failures.push(
        `${name}: aggregate SQL references sensitive field ${field}`,
      );
  }
}

const expected = [
  "acquisition-funnel.sql",
  "analytics-delivery-health.sql",
  "scan-health.sql",
  "check-health.sql",
  "fingerprint-summary.sql",
  "worker-queue-health.sql",
  "privacy-retention-audit.sql",
  "verified-lead-worklist.restricted.sql",
];
for (const name of expected) {
  if (!files.includes(name)) failures.push(`missing dashboard query: ${name}`);
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `Validated ${files.length} dashboard SQL files; aggregate queries exclude blocked fields.\n`,
);
