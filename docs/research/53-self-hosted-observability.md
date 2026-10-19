# Self-hosted observability

The owner requests logs and necessary telemetry for TEST and PRODUCTION in
the shared self-hosted stack, without alerts. The collector and its operating
procedure live in [deploy/observability](../../deploy/observability/README.md).
Shared destination deployment belongs to `nuanu-ai/observability`; mesh access
belongs to `nuanu-ai/infra`. The owner explicitly directs that the overview be
created directly in self-hosted Grafana and adopted afterward.

Read-only inspection on 2026-10-19 finds TEST's application containers healthy
with local Docker logs and no collector. PRODUCTION's `alloy.service` is
active but attempts to write to Grafana Cloud: over a sampled twenty minutes,
its journal contains 864 error lines, including 844 HTTP 401 lines. Its
running counters report zero delivered Loki entries and 401,472 entries
dropped because the receiver rejected them. These are counters for that
process lifetime, not a twenty-minute loss estimate.

The Joglo backend is running and serves existing producers, but its live writer
inventory has no Agentify identity. Network access is delivered by
[infra PR 370](https://github.com/nuanu-ai/infra/pull/370), merged as
`11988e5039c03def21de22a56ce18fdf499305ae`. Its exact-commit apply and convergence
pass. Both producer hosts resolve the private gateway, connect to TCP/8443,
verify its hostname with the pinned CA, and receive HTTP 401 for unauthenticated
log and metric writes. TCP/8444 remains unreachable. This is access acceptance;
authenticated ingestion and destination readback remain pending.

The prepared connection gives each channel its own metrics/logs writer,
allows only the two inspected mesh identities to Joglo TCP/8443, pins Joglo's
TLS root, and installs one separate collector per host. The Grafana view
compares readiness, host capacity and collector delivery. No alert rules or
notification routes are added. TEST email links and raw database logs stay
local. Trace collection and application metric endpoints are outside this
connection; the existing health route already reads the scanner's operational
signals without exposing a new public surface.

Live activation remains pending the reviewed shared changes. Acceptance means
fresh real log readback and metrics from both channels at the destination,
with negative authorization and privacy checks. Local checks are evidence for
the configuration, not a claim that either channel is delivering.

Local verification uses the pinned Alloy image. Both channel configurations
validate. Docker fixtures preserve the production selector structure, deliver
commerce/scanner diagnostics and edge logs from both allowed projects, and
exclude sandbox mail, an unrelated project and an unrelated service. Removing either mail exclusion causes
the smoke check to fail. A separate full collector run delivers real exporter
samples to an isolated HTTP receiver: decoded Prometheus remote-write samples
contain the three canonical jobs, three distinct readiness components, and the
expected channel labels. Removing writer onboarding also causes its behavioral
test to fail. The separate adversarial review found a Docker filter error:
multiple values for the same label key require all values to match. The
corrected configuration discovers the project label and explicitly keeps
either allowed project through relabeling. The revised smoke fails on the
broken selector and passes on the corrected source. The reviewer independently
re-ran it and reports no unresolved findings.

Removing project isolation also fails the smoke on the unrelated project's
synthetic log. A full production-channel collector run against an isolated
receiver exercises both accepted and rejected Loki batches; every metric name
and `component_id` used by the overview matches actual exported samples. All
nine overview expressions pass authenticated read-only queries on Joglo with
empty results, as expected before producer installation. The overview is
created directly at
[`/d/agentify-overview/agentify`](https://grafana.nuanu.ai/d/agentify-overview/agentify),
in folder UID `cg1pizzl7hl34c`; the owner will adopt it afterward. No dashboard
infrastructure PR or validation-pipeline change is published. `pnpm test` passes
5,250 unit cases and both 14-case operational suites; Biome reports no errors.

The destination's complete local validation passes 213 tests, Ansible lint and
playbook syntax checks; both CI runs for
[observability PR 27](https://github.com/nuanu-ai/observability/pull/27) pass.
The accepted access change passed the current infra repository validator and
the full Headscale shell suite under Linux. Its owner-dispatched exact-head
plan updated only `headscale_policy.main`; the merged-commit apply, convergence
and acceptance checks pass. Destination writer activation and producer
installation remain pending the reviewed source changes.
