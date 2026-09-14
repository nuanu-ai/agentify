FROM node:24.21.0-alpine

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    COREPACK_HOME=/pnpm/corepack \
    PATH=/pnpm:$PATH

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node agentify/package.json agentify/package.json
COPY --chown=node:node agentify/tsconfig.base.json agentify/tsconfig.base.json
COPY --chown=node:node agentify/packages/contracts/package.json agentify/packages/contracts/package.json
COPY --chown=node:node agentify/packages/db/package.json agentify/packages/db/package.json
COPY --chown=node:node agentify/packages/analytics/package.json agentify/packages/analytics/package.json
COPY --chown=node:node agentify/packages/observability/package.json agentify/packages/observability/package.json
COPY --chown=node:node agentify/packages/scanner-core/package.json agentify/packages/scanner-core/package.json
COPY --chown=node:node agentify/apps/scanner-worker/package.json agentify/apps/scanner-worker/package.json
RUN pnpm install --frozen-lockfile --filter agentify --filter @b2a/scanner-worker...

COPY --chown=node:node agentify/packages agentify/packages
COPY --chown=node:node agentify/apps/scanner-worker agentify/apps/scanner-worker
RUN pnpm --filter @b2a/contracts build \
  && pnpm --filter @b2a/analytics build \
  && pnpm --filter @b2a/observability build \
  && pnpm --filter @b2a/db build \
  && pnpm --filter @b2a/scanner-core build \
  && pnpm --filter @b2a/scanner-worker build

USER node
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/health/ready >/dev/null || exit 1
CMD ["node", "agentify/apps/scanner-worker/dist/index.js"]
