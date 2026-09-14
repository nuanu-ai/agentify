FROM apify/actor-node-playwright-chrome:24-1.61.1

WORKDIR /home/myuser

USER root
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate
USER myuser

COPY --chown=myuser:myuser package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=myuser:myuser agentify/package.json agentify/package.json
COPY --chown=myuser:myuser agentify/tsconfig.base.json agentify/tsconfig.base.json
COPY --chown=myuser:myuser agentify/packages/contracts/package.json agentify/packages/contracts/package.json
COPY --chown=myuser:myuser agentify/packages/scanner-core/package.json agentify/packages/scanner-core/package.json
COPY --chown=myuser:myuser agentify/apps/browser-observer-actor/package.json agentify/apps/browser-observer-actor/package.json

RUN pnpm install --frozen-lockfile \
      --filter agentify \
      --filter @b2a/contracts \
      --filter @b2a/scanner-core \
      --filter @b2a/browser-observer-actor

COPY --chown=myuser:myuser agentify/packages/contracts agentify/packages/contracts
COPY --chown=myuser:myuser agentify/packages/scanner-core agentify/packages/scanner-core
COPY --chown=myuser:myuser agentify/apps/browser-observer-actor agentify/apps/browser-observer-actor

RUN pnpm --filter @b2a/contracts build \
    && pnpm --filter @b2a/scanner-core build \
    && pnpm --filter @b2a/browser-observer-actor build

CMD ["node", "agentify/apps/browser-observer-actor/dist/index.js"]
