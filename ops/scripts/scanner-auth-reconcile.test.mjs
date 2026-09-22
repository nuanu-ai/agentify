import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./scanner-auth-reconcile.mjs", import.meta.url).pathname;
const source = [
  { id: "u1", email: "linked@example.invalid", confirmed: true, linked_leads: 1 },
  { id: "u2", email: "unlinked@example.invalid", confirmed: true, linked_leads: 0 },
  { id: "u3", email: "pending@example.invalid", confirmed: false, linked_leads: 0 },
];

function run(links, newAuth = [], sourceRows = source, privateBaseline = false) {
  const dir = mkdtempSync(join(tmpdir(), "scanner-auth-reconcile-"));
  try {
    const sourcePath = join(dir, "source.ndjson");
    const linksPath = join(dir, "links.ndjson");
    const newAuthPath = join(dir, "new.ndjson");
    const reportPath = join(dir, "report.json");
    for (const [path, rows] of [
      [sourcePath, sourceRows],
      [linksPath, links],
      [newAuthPath, newAuth],
    ]) {
      writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });
    }
    const result = spawnSync(
      process.execPath,
      [
        script,
        sourcePath,
        linksPath,
        reportPath,
        ...(privateBaseline ? ["--private-baseline"] : []),
        newAuthPath,
      ],
      { encoding: "utf8" },
    );
    return { result, report: JSON.parse(readFileSync(reportPath, "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("confirmed source-only identity blocks retirement while pending identity is flagged for resend", () => {
  const { result, report } = run([{ id: "l1", supabase_user_id: "u1" }]);
  assert.equal(result.status, 2);
  assert.equal(report.confirmed_unlinked_needing_fresh_verification[0].auth_id, "u2");
  assert.equal(report.pending_users_needing_resend[0].auth_id, "u3");
  assert.equal(result.stdout.includes("unlinked@example.invalid"), false);
});

test("freshly verified email resolves the source-only identity and foreign lead links are refused", () => {
  const verified = [{ email: "unlinked@example.invalid", email_verified: true }];
  const clear = run([{ id: "l1", supabase_user_id: "u1" }], verified);
  assert.equal(clear.result.status, 0);
  const foreign = run([{ id: "l1", supabase_user_id: "u4" }], verified);
  assert.equal(foreign.result.status, 2);
  assert.equal(foreign.report.foreign_lead_links[0].auth_id, "u4");
  assert.equal(foreign.report.changed_source_links[0].auth_id, "u1");
});

test("Auth-window reconciliation uses current private lead links instead of stale external counts", () => {
  const sourceAfterBridge = [
    { id: "u1", email: "linked@example.invalid", confirmed: true, linked_leads: 0 },
    { id: "u2", email: "unlinked@example.invalid", confirmed: true },
    { id: "u3", email: "pending@example.invalid", confirmed: false },
  ];
  const { result, report } = run(
    [{ id: "new-lead", supabase_user_id: "u1" }],
    [],
    sourceAfterBridge,
    true,
  );
  assert.equal(result.status, 2);
  assert.deepEqual(report.changed_source_links, []);
  assert.equal(report.confirmed_unlinked_needing_fresh_verification[0].auth_id, "u2");
  assert.equal(report.pending_users_needing_resend[0].auth_id, "u3");
  assert.equal(report.link_count_baseline, "current_private_leads");
  assert.equal(result.stdout.includes("linked@example.invalid"), false);
});
