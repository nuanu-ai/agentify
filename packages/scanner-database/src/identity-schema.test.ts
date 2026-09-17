import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  registrationIntents,
  scannerIdentityCompletions,
  scannerIdentityDeletionOperations,
  scannerRecoveryIntents,
} from "./schema";

describe("scanner-owned report identity schema", () => {
  it("allows independently accepted registration links for one scan and email", () => {
    const config = getTableConfig(registrationIntents);
    expect(config.indexes.map((index) => index.config.name)).not.toContain(
      "registration_intents_active_scan_email_uidx",
    );
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "registration_intents_callback_state_uidx",
    );
  });

  it("keeps imported recovery authority keyed by cabinet token hash, not state", () => {
    const config = getTableConfig(scannerRecoveryIntents);
    expect(config.name).toBe("scanner_recovery_intents");
    expect(
      config.uniqueConstraints.map((constraint) => constraint.name),
    ).not.toContain("scanner_recovery_intents_state_hash_unique");
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "scanner_recovery_intents_token_hash_uidx",
    );
  });

  it("stores no raw email, state, token or report capability in completion rows", () => {
    const columns = getTableConfig(scannerIdentityCompletions).columns.map(
      (column) => column.name,
    );
    expect(columns).toEqual([
      "receipt_id",
      "token_hash",
      "intent_kind",
      "state_hash",
      "lead_id",
      "scan_id",
      "completed_at",
      "retain_until",
    ]);
  });

  it("keeps one durable deletion operation and a lease ownership token per lead", () => {
    const columns = getTableConfig(
      scannerIdentityDeletionOperations,
    ).columns.map((column) => column.name);
    expect(columns).toEqual([
      "operation_id",
      "lead_id",
      "cabinet_result",
      "lease_token",
      "lease_expires_at",
      "created_at",
      "completed_at",
    ]);
  });
});
