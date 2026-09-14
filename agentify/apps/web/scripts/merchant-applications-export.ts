import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { merchantApplications } from "@b2a/db";
import { desc, gt } from "drizzle-orm";
import { getServerConfig } from "../lib/server/config";
import { decryptSensitiveValue } from "../lib/server/crypto";
import { getDatabase } from "../lib/server/database";

// Explicit local export only: no API route, analytics, stdout PII or automatic messaging.
async function main() {
  const destination = process.env.MERCHANT_EXPORT_PATH;
  if (
    process.env.MERCHANT_EXPORT_ACK !== "yes" ||
    !destination ||
    !isAbsolute(destination)
  )
    throw new Error("explicit_private_export_required");
  const { db, pool } = getDatabase();
  try {
    const rows = await db
      .select()
      .from(merchantApplications)
      .where(gt(merchantApplications.expiresAt, new Date()))
      .orderBy(desc(merchantApplications.createdAt))
      .limit(1000);
    const records = rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      policyVersion: row.policyVersion,
      application: JSON.parse(
        decryptSensitiveValue(
          row.payloadCiphertext,
          getServerConfig().encryptionKey,
        ),
      ),
    }));
    await writeFile(destination, JSON.stringify(records, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    process.stdout.write(
      `Exported ${records.length} applications to the requested private file.\n`,
    );
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  process.stderr.write("Merchant export failed; no contact data logged.\n");
  process.exitCode = 1;
});
