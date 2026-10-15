# API input and serialization campaign

All 350 registered correctness cases pass against product commit
`e11fef741e875ef6f9c42465a6b27577dd2921a1`. The campaign follows the API section
of [the frozen plan](plan.md), committed as `f1ca8e19`. Product implementation
is unchanged. [The sanitized case ledger](api-evidence.json) records every case,
seed, expected and observed classification, input, and HTTP observation.

| Registered group | Executed | Outcome |
| --- | ---: | --- |
| Eight input-schema families, 32 cases each | 256 | 49 accepted and 207 refused, all matching independently assigned verdicts |
| Accepted documentation-card round trips | 64 | Canonical parsing, publication, merchant readback, public projection and discovery agree |
| Complete-list comparisons | 6 | Public and merchant lists retain all 1, 10 and 100 accepted cards without duplicates or altered content |
| Malformed JSON, six forms across four POST routes | 24 | Every request returns 400, `malformed_body`, `retryable: false`, and preserves merchant state |

The original broader API assignment encountered a service cybersecurity-risk
filter. Its replacement scope is offline input validation and serialization
correctness. These results provide no security-isolation or deployed-payment
coverage. The gateway uses its real application flows with memory stores and a
scripted facilitator; HTTP listeners bind only to `127.0.0.1`. No chain,
database, external merchant, mail service or deployed environment is contacted.
The largest allowed input is 262,144 bytes. The cases here stay below that cap;
they do not measure the parser's exact body-size boundary.

The input families are cards, purchases, worker polls, key issuance, merchant
settings, quote answers, handler answers and order-list queries. Their expected
verdicts are declared explicitly from the consumer rules: missing required
fields, wrong document and field types, closed object fields, blank strings,
length boundaries, exact decimal spelling and integer boundaries. A format
schema accepting a readable zero price or a delivery with arbitrary values is
not a publish or delivery authorization: separate admission and card-specific
rules apply. This distinction is retained in the case names and ledger.

Seeds `0xA61015A1` and `0xA61015A2` determine the schema-case execution order.
They do not turn the finite sample into exhaustive input coverage. The 64 HTTP
round trips exhaust two existing documentation variants, each with 32
combinations: price string or object, result-field shorthand or full form,
implicit or explicit synchronous fulfillment, and four permitted spellings of
the same five-dollar amount. Merchant readback and the public document are
compared with independently assembled expected documents. The challenge is
decoded with the protocol library and compared with fixed expected atomic
amount, purchase method, input and delivery example. Its header measures
1,784–1,868 bytes in these cases. A GET probe creates no order.

List comparisons check both identity sets and every item's content. They make
no ordering or pagination promise. The catalog contract deliberately leaves
paging undesigned (`packages/contracts/src/api.ts:373`), so a successful
100-item comparison says nothing about a complete larger catalog or an
operational response-size bound. Root owns the separate discovery-header
parameter-width experiment.

Malformed JSON is sent to `/v0/catalog/publish`, `/v0/keys`,
`/v0/seller-name` and `/v0/worker/poll`. The forms are an unfinished object,
trailing comma, unquoted key, single quotes, concatenated documents and an
invalid escape. Before and after snapshots compare cards, seller settings,
key metadata and orders. No key secret is included in evidence.

The successful command is:

```sh
API_CAMPAIGN_SCHEMA_EVIDENCE=/tmp/agentify-api-schema-evidence.json \
API_CAMPAIGN_HTTP_EVIDENCE=/tmp/agentify-api-http-evidence.json \
pnpm exec vitest run --project unit \
  packages/contracts/src/input-campaign.test.ts \
  apps/gateway/src/http/serialization-campaign.test.ts \
  --maxWorkers=1 --reporter=json --outputFile=/tmp/agentify-api-vitest.json
```

The runtime is Node `v26.7.0`, Vitest `4.1.11`. Both package typechecks pass,
and Biome checks the new tests. The initial sandboxed HTTP run is an environment
failure: Vitest's worker receives `listen EPERM` on loopback, and a one-case
diagnostic times out. That run is interrupted; explicitly authorized loopback
execution passes all 94 HTTP cases. An initial scratch mutation attempt also
collects zero tests because its copied package cannot resolve `zod`; linking
the existing package dependencies resolves that harness error. Neither failure
is classified as a product defect.

Mutation controls operate on isolated temporary copies. Unmodified copies pass
all 256 schema and 94 HTTP cases. Raising the description ceiling by one is
killed by the 501-character case. Widening the order-query vocabulary from the
two declared words to arbitrary strings is killed by nine cases. Removing the
public card description is killed by 67 wire comparisons. All three mutations
apply and are killed; none survives. The campaign checkout's product source is
never mutated.

No product defect is confirmed by this bounded API group, so no expected-failure
test is needed. The two test files are executable under the normal unit project.
They write case ledgers only when the two explicit evidence environment variables
are set. Remaining gaps include PostgreSQL behavior, list sizes above 100,
broader transport behavior, deployed acceptance and the excluded security scope.
