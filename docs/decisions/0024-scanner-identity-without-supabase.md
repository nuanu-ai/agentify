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

The scanner's tables live in the product's one database, `agentify`, beside
the gateway's and the cabinet's (ADR-0003), and every process reaches it with
the one account, `agentify`. The scanner's four service roles — web, worker,
privacy and dashboard — their reconcile, finalize and verify jobs, the
policies and grants that named them and the Metabase views the fourth read
are deleted (Dmitry's word, 2026-09-22 and 2026-09-23): they cost three
activation steps and four sets of credentials to separate processes that are
all ours on one host, and each host drops them when it moves to one
database. The account is the instance's bootstrap superuser, so it owns every
table and leaves the schema's row-level security inert — twenty-six scanner
tables declare it, three force it on their owner, and no policy exists. What
keeps scanner data and cabinet data apart is therefore the identity route and
the secret only those two processes hold, not the database: neither process
reads or writes the other's tables (Dmitry's word, 2026-09-23).

The cabinet owns identity (ADR-0026). Email verification uses Better Auth's
expiring, hashed, single-use magic links. The scanner asks the cabinet over an
internal route to send one; every link lands on the cabinet's page and is
consumed only by an explicit same-origin submission there, which opens the
session and sends the browser on. The scanner never handles a token. A request
for a full report is finished at the first visit of the session its own link
opened, which the cabinet names when asked whose session a cookie is, and the
lead is linked to the scan in the scanner's own transaction, so the two
processes, each committing its own half, never need to share one. No separate
identity service is deployed, and the scanner's tables hold no identity data. Registration keeps its intent,
email, scan and consent checks, a session finishes only the intent its own link
was asked for or its own signed-in ask made, and scanner permissions
are checked against report ownership. Where a link leads is recorded with its
token, the full report of a named scan or a named cabinet screen, and nothing in
the link is read as a destination; a session is shown a report only when its
address owns it; anybody else asks for it, and a request for a link meets one
generic answer whether a report exists or a rate limit applies. The scanner
keeps no session of its own and asks the cabinet whose session a cookie is
(ADR-0026). Privacy deletion removes the lead, which is what gave the address
its reports, and for a person who owns no merchant the identity row in the
cabinet. The Supabase user ID on older leads is migration provenance, never a
credential, and no Supabase access or refresh token is accepted.

## Consequences

Running the complete Supabase platform ourselves adds services without advancing
the shared stack. Reusing legacy hand-written verification avoids a dependency
but abandons the component boundary established by ADR-0009. The route above is
the cabinet's second listener, publishing no port and reached by service name;
the release proves that each of the cabinet's internal credentials, this one and
the gateway's (ADR-0019), is held by its own two processes and by no other
service in the rendered graph.
Cross-domain SSO and automatic merging of scanner and merchant
identities are not built; the one session for the site and what crosses the
boundary are ADR-0026's decision, and the separation above stands for scans,
reports and leads.
