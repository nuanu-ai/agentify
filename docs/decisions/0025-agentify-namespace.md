# 0025. One Agentify namespace, with an explicit state cutover

Date: 2026-09-16
Status: accepted (Dmitry's live instruction)

## Context

The product, merchant packages and public domains use Agentify. Application
identifiers also name stored state and deployment resources. Renaming their
source literals does not move that state and can start an empty database or
queue while the original still holds work.

## Decision

Current tracked source, paths, documentation and fixtures use Agentify. There
are no former-name aliases, dual writes, fallback variables or encoded former
names. Git and published releases retain the original historical record;
archived descriptions anonymize identifiers explicitly rather than claiming
that a new execution occurred. Copyright ownership and license terms remain.

Commerce uses database/role `agentify_commerce` and scratch database
`agentify_commerce_test`. Its queues, locks and cookies use the Agentify
namespace. Scanner storage remains separate. The scanner's cookies, browser
storage keys, DOM attributes, Postgres application names and the metadata it
writes to Stripe use the Agentify namespace too: a consent
choice stored under the former key is asked for once more, and a card-signal
setup opened under the former metadata keys is not reconciled after the
switch. Deployment variables, resource names and page markers change with
their producers, consumers and checks.

The cookie prefix change requires cabinet users to sign in again; accounts
and credentials are retained. Cleanup for the pre-component credential cookies
is removed: their issuers used a twelve-hour maximum age and were retired
on 2026-08-28. Broad origin cookie clearing would disturb unrelated sessions.
New WooCommerce orders use the Agentify payment
method and metadata key. Historical merchant-owned orders are not rewritten.
Seeded platform names may be updated only for positively identified seed rows;
merchant-selected names and historical receipts are not normalized wholesale.

JSON Schema identifiers use `urn:agentify:contract:2:*`. This deliberately
changes schema identity for consumers keyed to the former URNs. It does not
change payload validation or vocabulary, so the handshake remains version
`2` under ADR-0006. No alias schema is provided. A comparison excluding `$id`
must establish that the schema bodies are unchanged.

Existing hosts require a separately authorized maintenance cutover
before these definitions can be deployed. It must identify source and target,
stop all writers, preserve and restore-check data, resolve pending queue work,
map volumes explicitly, replace environment and service names, and retain a
rollback that includes configuration and data. A Compose project name is the
prefix on every container and the label every volume is found by, so each
host keeps the project and container names it was created under and moves
them with the database in the one-database step, inside that one cutover;
images, source and the edge's route table take the new names now. Host
delivery and npm publication are separate gates under ADR-0016: TEST's timer
delivers automatically, a person delivers PRODUCTION, and the production
namespace cutover remains paused. Branch acceptance proves the new source and
isolated checks; it does not prove migration of a live host.

## Alternatives rejected

Global substitution without consumer analysis can redirect writes to empty
state or make a retired-source selector address the active target. Keeping
aliases obscures the transition and contradicts the requested single name.
Renaming historical business records changes evidence rather than branding.
