FROM node:24.18.0-alpine

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
COPY --chown=node:node packages/db/package.json packages/db/package.json
COPY --chown=node:node packages/analytics/package.json packages/analytics/package.json
COPY --chown=node:node packages/observability/package.json packages/observability/package.json
COPY --chown=node:node packages/scanner-core/package.json packages/scanner-core/package.json
COPY --chown=node:node apps/scanner-worker/package.json apps/scanner-worker/package.json
RUN pnpm install --frozen-lockfile

COPY --chown=node:node packages packages
COPY --chown=node:node apps/scanner-worker apps/scanner-worker
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
CMD ["node", "apps/scanner-worker/dist/index.js"]
