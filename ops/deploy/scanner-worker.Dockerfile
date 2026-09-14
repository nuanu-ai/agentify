FROM node:24.21.0-alpine

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    COREPACK_HOME=/pnpm/corepack \
    PATH=/pnpm:$PATH

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node tsconfig.scanner.json ./
COPY --chown=node:node packages/scanner-contracts/package.json packages/scanner-contracts/package.json
COPY --chown=node:node packages/scanner-database/package.json packages/scanner-database/package.json
COPY --chown=node:node packages/analytics/package.json packages/analytics/package.json
COPY --chown=node:node packages/observability/package.json packages/observability/package.json
COPY --chown=node:node packages/scanner/package.json packages/scanner/package.json
COPY --chown=node:node apps/scanner-worker/package.json apps/scanner-worker/package.json
RUN pnpm install --frozen-lockfile --filter @agentify/scanner-worker...

COPY --chown=node:node packages/scanner-contracts packages/scanner-contracts
COPY --chown=node:node packages/scanner-database packages/scanner-database
COPY --chown=node:node packages/analytics packages/analytics
COPY --chown=node:node packages/observability packages/observability
COPY --chown=node:node packages/scanner packages/scanner
COPY --chown=node:node apps/scanner-worker apps/scanner-worker
RUN pnpm --filter @agentify/scanner-contracts build \
  && pnpm --filter @agentify/analytics build \
  && pnpm --filter @agentify/observability build \
  && pnpm --filter @agentify/scanner-database build \
  && pnpm --filter @agentify/scanner build \
  && pnpm --filter @agentify/scanner-worker build

USER node
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/health/ready >/dev/null || exit 1
CMD ["node", "apps/scanner-worker/dist/index.js"]
