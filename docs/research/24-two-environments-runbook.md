# Archived first-release environment procedure

The first-release reset procedure is retired. It assumed a disposable shared
database, a single deployment host and no production data to retain. Those
assumptions do not describe the current system. Its commands are available
in Git history for historical analysis and must not be used for delivery.

Production commerce is served at `https://agentify.ad`; the test cabinet
is served at `https://test.agentify.ad` on a different host. Scanner and
commerce application databases remain separate. Production data is retained.

Current deployment definitions and operator prerequisites live in
[the Ansible documentation](../../deploy/ansible/README.md). Infrastructure
changes are applied only through Ansible, with an explicitly authorized
release, a verified backup and restore, and a tested rollback. Automatic
delivery remains paused under [ADR-0016](../decisions/0016-two-channel-releases.md).

The namespace transition requires a separate maintenance cutover described
in [ADR-0025](../decisions/0025-agentify-namespace.md). Renamed Compose
definitions are not a migration of existing databases, volumes or queues.
