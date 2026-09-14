# Agentify workspace

This temporary workspace imports Agentify application code from
`nuanu-ai/agent-first-project` at commit
`33f3385d2be825022133b55d889f8a690f736e69`. Private research, meetings,
prompts, design sources, marketing material, runbooks, release evidence,
repository history, and secrets are not part of the import.

The production health monitor definition is retained under
`ops/deploy/workflows/` as inactive deployment configuration. GitHub does not
discover workflows at that path; activating it is a later deployment step.

The repository uses Node 24.21.x, pnpm 11.12.x, TypeScript 5.9.3 and one root
workspace lockfile. From the repository root:

```sh
pnpm install --frozen-lockfile
cp agentify/.env.example agentify/.env
pnpm agentify:db:up
pnpm agentify:db:migrate
pnpm agentify:dev
```

Agentify uses `http://localhost:3000` for the web application,
`http://localhost:8081` for worker health, and its PostgreSQL 16.9 database at
`127.0.0.1:55432`. These remain separate from the CoinSlot application on port
8080 and its local database on port 5432. `pnpm agentify:db:down` stops the
Agentify database without deleting its named volume.

The scoped verification commands are `agentify:check`,
`agentify:test:integration`, `agentify:test:actor`, `agentify:test:db`,
`agentify:build`, and `agentify:self-readiness`. Integration commands read the
local environment file created above. Browser integration additionally needs
the pinned Playwright Chromium installed for the Agentify workspace. The
self-readiness command checks the canonical public surface, so it must follow a
build made with `NEXT_PUBLIC_APP_BASE_URL=https://agentify.ad`; CI supplies that
candidate environment explicitly.

Scanner worker, web and Actor images use the repository root as their build
context so the shared lockfile is available. Their Dockerfile-specific ignore
files keep local plans, commerce code and unrelated scanner components out of
each context.
