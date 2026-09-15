import { readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";

const [sourcePath, targetPath, reportPath, ...extras] = process.argv.slice(2);
const privateBaseline = extras.includes("--private-baseline");
const newAuthPaths = extras.filter((arg) => arg !== "--private-baseline");
const newAuthPath = newAuthPaths[0];
if (!sourcePath || !targetPath || !reportPath) {
  console.error("Usage: scanner-auth-reconcile.mjs SOURCE_AUTH_NDJSON TARGET_LEADS_NDJSON PROTECTED_REPORT [--private-baseline] [NEW_AUTH_NDJSON]");
  process.exit(1);
}
if (newAuthPaths.length > 1 || (privateBaseline && extras.filter((arg) => arg === "--private-baseline").length !== 1)) {
  throw new Error("Only one current-private baseline mode and one new Auth input are allowed.");
}

function records(path) {
  if ((statSync(path).mode & 0o777) !== 0o600) {
    throw new Error("Identity input must be a protected 0600 file.");
  }
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const source = records(sourcePath);
const links = records(targetPath);
const newAuth = newAuthPath ? records(newAuthPath) : [];
const users = new Map();
for (const user of source) {
  if (!user.id || users.has(user.id) || typeof user.email !== "string" || typeof user.confirmed !== "boolean") {
    throw new Error("Source Auth inventory has an invalid or duplicate user.");
  }
  users.set(user.id, user);
}
const freshVerifiedEmails = new Set(newAuth.filter((u) => u.email_verified === true).map((u) => u.email?.toLowerCase()));
const linkedCounts = new Map();
const foreignLeadLinks = [];
for (const lead of links) {
  if (!lead.id || !lead.supabase_user_id) continue;
  if (!users.has(lead.supabase_user_id)) foreignLeadLinks.push({ lead_id: lead.id, auth_id: lead.supabase_user_id });
  linkedCounts.set(lead.supabase_user_id, (linkedCounts.get(lead.supabase_user_id) ?? 0) + 1);
}
const changedLinks = privateBaseline ? [] : source.filter((u) => Number(u.linked_leads) !== (linkedCounts.get(u.id) ?? 0));
const confirmedUnlinked = source.filter((u) => u.confirmed && (privateBaseline ? (linkedCounts.get(u.id) ?? 0) : Number(u.linked_leads)) === 0 && !freshVerifiedEmails.has(u.email.toLowerCase()));
const pending = source.filter((u) => !u.confirmed);
const report = {
  link_count_baseline: privateBaseline ? "current_private_leads" : "source_public_leads",
  source_users: source.length,
  target_linked_leads: links.filter((l) => l.supabase_user_id).length,
  foreign_lead_links: foreignLeadLinks,
  changed_source_links: changedLinks.map((u) => ({ auth_id: u.id, source_count: u.linked_leads, target_count: linkedCounts.get(u.id) ?? 0 })),
  confirmed_unlinked_needing_fresh_verification: confirmedUnlinked.map((u) => ({ auth_id: u.id, email: u.email })),
  pending_users_needing_resend: pending.map((u) => ({ auth_id: u.id, email: u.email })),
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
chmodSync(reportPath, 0o600);
console.log(`Identity custody: source=${source.length}, linked=${report.target_linked_leads}, foreign=${foreignLeadLinks.length}, changed=${changedLinks.length}, confirmed-unlinked=${confirmedUnlinked.length}, pending=${pending.length}.`);
if (foreignLeadLinks.length || changedLinks.length || confirmedUnlinked.length) process.exitCode = 2;
