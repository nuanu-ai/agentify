# ENG08: public build identity

Date: 2026-10-27. The product owner approves adding build identity to the
public gateway health response. This addresses the deployment-attribution part
of ENG08. Request timing and the behavior at the waiting-purchase limit remain
open.

`GET /healthz` returns HTTP 200 with `ok: true`, `revision` and
`contract_version`. The source revision comes from `AGENTIFY_SOURCE_REVISION`,
which CI writes into the image; the contract version comes from the shared
`CONTRACT_VERSION` constant. Blank, missing and the build's `unknown` value
produce `revision: null`. The operator's Health and the public response share
revision normalization. There is no new configuration setting or protocol bump.

The response sends `Cache-Control: no-store` and contains only these three
fields. It does not expose the RPC endpoint, credentials, business counts or
other operational configuration. It remains a liveness check with no serving
dependency checks. ADR-0040 records this public metadata boundary. The Caddy
comment and observability runbook describe the response.

Five HTTP checks first fail against the previous response. After the change,
538 tests pass in 20 files: the gateway HTTP suites, gateway health facts and
operator Health presentation. Gateway type checking, formatting and decision
checks pass on the verified source. Tests run on Node 24.22.1.

Four mutations apply and are killed: lose the known revision, report the wrong
contract version, remove `no-store` and expose the private RPC URL. The server
source is restored byte for byte after each. Its two affected suites then pass
103 tests. Missing and unknown build values remain successful liveness replies.

A separate Node run serves real loopback HTTP outside the fixture runner. After
app construction, any access to the gateway runtime deliberately throws. Health
still returns 200 for known, unknown, blank and absent revision values. Caller
headers and query parameters cannot supply the identity. The gateway is not
started, and the run contacts no database, RPC endpoint or external merchant.
This is a controlled dependency-access failure, not a deployed database outage.

A separate static review finds an obsolete Caddy comment claiming only
`{"ok":true}` is public. The comment is corrected; the second review finds no
remaining actionable issues. The reviewer does not independently run tests.

A read-only inspection of TEST finds image revision
`90a445c68ad6a8c9f5481678b97be0e592ee6983` and a bundled waiting-purchase limit
of 50. That verifies the image's constant, not the fifty-first HTTP request.
The new public response is not deployed to TEST or production in this step.

Private raw output and the standalone check script are kept in
`2026-10-27-eng08-y0nd0koj` under the operator's Agentify acceptance directory.
