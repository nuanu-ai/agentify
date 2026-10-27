# Agentify test audit

This adaptation keeps the upstream value and retention criteria. Repository
`AGENTS.md` and the user's task determine scope, authority and delivery.

An audit request starts with read-only discovery and an evidence report. It
does not by itself request a pruning campaign or product repairs. Use
`CAMPAIGN.md` only for an explicitly scoped whole-subsystem pruning campaign;
its OpenClaw examples are historical context, not Agentify tooling requirements.
For broad discovery, inventory all test surfaces, identify the areas inspected
in depth, and label uninspected areas. Do not claim a per-test verdict from a
pattern search or a sample.

## Boundary and cost

Exercise the production owner through a caller-visible boundary with independent
expected values and fixed external I/O. Preserve distinct transport, lifecycle,
security, storage and published-package contracts even when their inputs overlap.
Read the real dependency when an assertion depends on its behavior. A mock call
alone does not establish the outcome that dependency must produce.

Measure focused test duration when proposing an expensive test's consolidation.
Separate test execution time from transform/setup and whole-command wall time.
Keep real browser and database proof in their existing lanes; slow execution
alone is not evidence that a test is dispensable.

## Proof policy

- Record the audited commit and working-tree state. Keep failures separate from
  low-value-test candidates. Never weaken assertions or delete a failing test
  to make a baseline green.
- Use the Node version in `.nvmrc` and pnpm version in `package.json`.
  `pnpm test` runs offline unit tests and scanner operations tests. Focus a unit
  owner with `pnpm exec vitest run --project unit <file> --maxWorkers=1`.
- Select database and integration commands from `package.json` and CI. Database
  suites erase data: use isolated disposable test databases, never deployment
  credentials. Live chain, facilitator and merchant calls belong to smoke
  commands with an explicit spending cap and task authorization.
- Do not edit or mutate source while tests run in the same checkout. For a
  permitted mutation, name the prediction first, restore the source byte for
  byte, and distinguish killed, survived and did not apply.
- For edits, follow the repository's red-to-green and hand-over requirements.
  Run focused owner/sibling proof and required checks. `pnpm check`,
  `pnpm typecheck` and `pnpm deadcode` are the local static gates; CI also owns
  builds, database and browser proof. Documentation-only integration needs
  link/frontmatter inspection and `git diff --check`, not invented runtime tests.
- Use an independent agent for adversarial review when the repository requires
  it or the task delegates review. Report unresolved findings, exact commands,
  results and unrun proof. Do not import OpenClaw's maintainer or CI commands.
- Commit, push and open a PR under `AGENTS.md`; merging and moving deployment
  tags remain separate actions with their own review and authorization.
