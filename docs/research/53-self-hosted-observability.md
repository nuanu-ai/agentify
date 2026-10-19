# Self-hosted observability

The owner requests logs and necessary telemetry for TEST and PRODUCTION in
the shared self-hosted stack, without alerts. The collector and its operating
procedure live in [deploy/observability](../../deploy/observability/README.md).
Shared destination deployment belongs to `nuanu-ai/observability`; mesh access
and the Grafana overview belong to `nuanu-ai/infra`.

Read-only inspection on 2026-10-19 finds TEST's application containers healthy
with local Docker logs and no collector. PRODUCTION's `alloy.service` is
active but attempts to write to Grafana Cloud: over a sampled twenty minutes,
its journal contains 864 error lines, including 844 HTTP 401 lines. Its
running counters report zero delivered Loki entries and 401,472 entries
dropped because the receiver rejected them. These are counters for that
process lifetime, not a twenty-minute loss estimate.

The Joglo backend is running and serves existing producers, but its writer
inventory has no Agentify identity. The current mesh policy has no TEST or
PRODUCTION grant to the private ingestion port. PRODUCTION's direct TCP/8443
attempt times out; TEST does not resolve the gateway's mesh name through its
system DNS. Local logs, healthy application containers and a running Alloy
therefore do not prove centralized observability.

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
validate. Docker fixtures deliver scanner and commerce diagnostics and exclude
sandbox mail and an unrelated service. Removing either mail exclusion causes
the smoke check to fail. A separate full collector run delivers real exporter
samples to an isolated HTTP receiver: decoded Prometheus remote-write samples
contain the three canonical jobs, three distinct readiness components, and the
expected channel labels. Removing writer onboarding also causes its behavioral
test to fail. The separate adversarial review has no unresolved findings.

The destination's complete local validation passes 213 tests, Ansible lint and
playbook syntax checks. Infra's two narrow ACL contracts, Grafana stack tests,
formatting and provider configuration validation pass. Its repository-wide
validator stops on the existing expired `telegram-proxy` experiment; that
unrelated resource is unchanged. The full Headscale shell suite requires a
newer Bash than the local system provides. No provider plan, shared apply,
destination activation or producer installation is claimed by these checks.
