# 0024. Scanner identity and data live in our PostgreSQL

Date: 2026-09-15
Status: accepted

## Context

The scanner began on a managed Supabase database and Supabase email
authentication, while the cabinet already ran Better Auth with a verified
Resend sender on our infrastructure. Report ownership and merchant tenancy are
separate security boundaries on a shared repository and host, so the move had
to keep existing reports and accounts without granting scanner visitors
merchant access. It is complete: on both channels the scanner's data is in
our PostgreSQL, and the people it confirmed are in the cabinet.

## Decision

The scanner uses a separate database in the existing PostgreSQL instance and
reaches it with the same account the gateway and the cabinet use. Its four
service roles — web, worker, privacy and dashboard — their reconcile, finalize
and verify jobs and the Metabase views the fourth read are deleted (Dmitry's
word, 2026-09-22): they cost three activation steps and four sets of
credentials to separate processes that are all ours on one host. That account
is the instance's bootstrap superuser, so it owns the scanner's tables,
reaches the commerce database by changing one word in a connection string, and
leaves the schema's row-level security inert — twenty-six tables declare it,
three force it on their owner, and no policy exists. What keeps scanner data
and cabinet data apart is therefore the identity route and the secret only
those two processes hold, not the database. The separate database is the
present state and not the destination: one database is the goal, but not
immediate (Dmitry's word, 2026-09-22), and the merge is a decision of its own
when he names the day.

The cabinet owns identity (ADR-0026). Scanner email verification uses Better
Auth's expiring, hashed, single-use magic links, issued and verified by the
cabinet's component over an internal route and consumed only by an explicit
same-origin submission; no separate identity service is deployed, and the
scanner database holds no identity data. Registration keeps its intent, email,
scan and consent checks, a verified identity finishes only the intent for that
same email, and scanner permissions are checked against report ownership. A
callback state is only a report-routing hint: a valid report session may follow
it only to a report that session owns, and otherwise the owner requests a
fresh, purpose-bound link, with one generic answer whether a report exists or a
rate limit applies. Privacy deletion revokes report access, removes the lead
and, for a person who owns no merchant, the identity row in the cabinet. The
Supabase user ID on older leads is migration provenance, never a credential,
and no Supabase access or refresh token is accepted.

## Consequences

Running the complete Supabase platform ourselves adds services without advancing
the shared stack. Reusing legacy hand-written verification avoids a dependency
but abandons the component boundary established by ADR-0009. The route above is
the cabinet's second listener, publishing no port and reached by service name;
the release proves no other service in the rendered graph holds either half of
its credential. Cross-domain SSO, a shared session and automatic merging of
scanner and merchant identities are not built; what crosses the boundary is
ADR-0026's decision, and the separation above stands for scans, reports and
leads.
