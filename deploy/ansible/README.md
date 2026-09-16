# Agentify server operations

Application changes on the production host are made through Ansible. The
machine baseline remains in `nuanu-ai/infra`; this directory does not provision
servers, change DNS, publish packages, or create payment probes.

`prepare-production.yml` is the greenfield staging entry point. It checks out
one explicit 40-character release SHA, verifies a clean checkout and protected
configuration, resolves the commerce and edge definitions, and prepares the
immutable images without activating a resident service. Run its syntax check
locally before any server preview:

```sh
ansible-playbook -i deploy/ansible/inventory.yml \
  deploy/ansible/prepare-production.yml --syntax-check
```

The current production database is not yet stored under the repository's final
namespace. Ordinary production delivery therefore remains blocked until a
separately reviewed Ansible cutover has stopped writers, preserved a verified
backup, restored the commerce database and role as `agentify_commerce`, and
mapped the restored data volume to `agentify-commerce-postgres`. The scanner
stays in the separate `agentify_scanner` database. Do not create either target
by hand to make a Compose check pass.

The queue gate is lossless. Drain or replay each pending job, or reconcile it
to the order and durable effect it represents. A job may leave the queue only
after the related business obligation is proved complete, is safely replayed,
or is put into named manual custody with its payload, order, owner and next
action recorded. A queue name and count alone never authorize disposal. If any
job cannot be reconciled that way, the cutover stops and the source state stays
available for rollback.

The test pull service is likewise inert until its Ansible cutover has restored
the retained application data into `agentify_commerce` on the test host, mapped
the external `agentify-test-postgres` and `agentify-test-caddy` volumes,
installed the renamed unit files, and preserved the timer's disabled state.
`agentify_commerce_test` is only the disposable database used by `pnpm test:db`;
it never stores retained application data. The release receiver checks the
external volumes before it accepts a candidate, then uses the
`deploy/compose.agentify-test.yaml` override. Production has no corresponding
direct release mode; it continues through Ansible because the commerce and
scanner routes share the public edge. Production also maps
`agentify-commerce-caddy` explicitly with its database volume.

The scanner database and Auth playbooks are retained recovery tools. They keep
scanner storage separate and use the commerce PostgreSQL owner only as the
administrative connection to the shared server. Their source evidence and
protected operation variables stay outside Git. Rehearse their restore path
with `ops/scripts/scanner-db-rehearsal.sh` and
`ops/scripts/scanner-db-real-schema-rehearsal.sh`; neither command contacts a
live service.

Completed source-to-target commerce and test migration playbooks are removed.
Their embedded source selectors described runtimes that no longer own traffic;
renaming those selectors to the target would make destructive assertions point
at the live target. Recovery evidence remains outside the repository. A new
namespace cutover is executed from an ignored, reviewed operation file with
explicit source values discovered at execution time, never from guessed or
encoded legacy names in tracked code.
