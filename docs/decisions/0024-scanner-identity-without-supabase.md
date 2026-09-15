# 0024. Scanner identity and data live in our PostgreSQL

Date: 2026-09-15
Status: accepted for preparation; production activation is a separate operation

## Context

The scanner uses a managed Supabase database and email authentication while
the commercial cabinet already runs Better Auth and Resend on our infrastructure.
The repository and production host are shared, but report ownership and merchant
tenancy are separate security boundaries. Moving infrastructure must preserve
existing reports and accounts without granting scanner visitors merchant access.

## Decision

The scanner uses a separate database in the existing production PostgreSQL
instance. Its application, queue and dashboard schemas retain their permissions;
commerce data is never a restore target. Database relocation and identity
replacement are separate cutover steps, with verification between them.

Scanner email verification uses the cabinet's pinned Better Auth version and
the scanner's existing Resend sender. Better Auth owns expiring, hashed, single-use
magic links. Scanner-prefixed identity tables and restricted roles keep identity
data inaccessible to the worker and dashboard. No new identity service is deployed.

Registration retains its existing intent, email, scan and consent checks. Opening
a mailed link presents confirmation; verification requires an explicit same-origin
submission so mail previews cannot consume it. A verified identity can finish
only the intent for that same email. Existing report sessions and lead IDs remain
valid; scanner permissions continue to be checked against report ownership.
Better Auth's internal session is not a shared browser login for commerce.

Existing leads link to the new identity only after fresh email verification.
An export and reconciliation of old linked identities is required before retiring
Supabase. The old Supabase user ID is retained as migration provenance, not as an
active authentication credential. Existing commerce accounts, passwords, sessions,
invitation requirements and merchant keys are unchanged.

## Consequences

Database handoff freezes the scanner's writers and scheduled jobs, preserves a
protected source dump off the VM, restores into an empty scanner destination and
verifies data and permissions before activation. After new writes, recovery must
reconcile those writes; restarting the old worker is not a safe rollback.

Pending Supabase email links require a replacement link after identity cutover.
Existing report sessions do not require a bulk password or merchant migration.
Privacy deletion must remove the new linked identity and revoke report access.
Supabase retirement follows database, queue, mail and report-access acceptance.

Running the complete Supabase platform ourselves adds services without advancing
the shared stack. Reusing legacy hand-written verification avoids a dependency
but abandons the component boundary established by ADR-0009. Cross-domain SSO and
automatic merging of scanner and merchant identities are separate product changes.
