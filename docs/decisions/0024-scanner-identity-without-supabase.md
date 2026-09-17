# 0024. Scanner identity and data live in our PostgreSQL

Date: 2026-09-15
Status: accepted

## Context

The scanner uses a managed Supabase database and email authentication while
the commercial cabinet already runs Better Auth and has a verified Resend sender
credential on our infrastructure.
The repository and production host are shared, but report ownership and merchant
tenancy are separate security boundaries. Moving infrastructure must preserve
existing reports and accounts without granting scanner visitors merchant access.

## Decision

The scanner uses a separate database in the existing production PostgreSQL
instance. Its application, queue and dashboard schemas retain their permissions;
commerce data is never a restore target. Database relocation and identity
replacement are separate cutover steps, with verification between them.

Scanner email verification uses Better Auth's expiring, hashed, single-use magic
links. Identity itself moved to the cabinet on 2026-09-17 (ADR-0026): the
scanner-prefixed identity tables that carried it through the Supabase exit retire,
the worker and dashboard reach no identity data because the scanner database holds
none, and still no new identity service is deployed — the cabinet's component
answers the scanner over an internal route.

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

An old Supabase callback state is only a report-routing hint. A valid report
session may follow it only to a report owned by that session. Otherwise the owner
requests a fresh, purpose-bound Better Auth link; the request has one generic
answer whether a report exists or a rate limit applies. Its hashed token is
consumed by an explicit same-origin submission in the same transaction that
creates the report session. An absent or cleaned hint falls back only to the
authenticated owner's latest report. Supabase access and refresh tokens are never
accepted.

## Consequences

Database handoff freezes the scanner's writers and scheduled jobs, preserves a
protected source dump off the VM, restores into an empty scanner destination and
verifies data and permissions before activation. After new writes, recovery must
reconcile those writes; restarting the old worker is not a safe rollback.

Pending Supabase email links for an existing verified lead require a replacement
link after identity cutover. A pending signup that never created a lead still
returns to registration; recovery does not invent ownership or replay consent.
Existing report sessions do not require a bulk password or merchant migration.
Privacy deletion revokes report access, removes the lead and, for a person who
owns no merchant, the identity row in the cabinet (ADR-0026).
Supabase retirement follows database, queue, mail and report-access acceptance.

Running the complete Supabase platform ourselves adds services without advancing
the shared stack. Reusing legacy hand-written verification avoids a dependency
but abandons the component boundary established by ADR-0009. Cross-domain SSO and
automatic merging of scanner and merchant identities are not built; what does cross
the boundary is decided in ADR-0026: at the moment the scanner confirms an address,
it asks the cabinet over an internal route for the cabinet's own sign-in link, and
the person carries that link as a navigation. No session or cookie is shared; the
identity row is the cabinet's, and the separation above stands for scans, reports
and leads.
