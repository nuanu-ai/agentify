FROM apify/actor-node-playwright-chrome:24-1.61.1

WORKDIR /home/myuser

USER root
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate
USER myuser

COPY --chown=myuser:myuser package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY --chown=myuser:myuser packages/contracts/package.json packages/contracts/package.json
COPY --chown=myuser:myuser packages/scanner-core/package.json packages/scanner-core/package.json
COPY --chown=myuser:myuser apps/browser-observer-actor/package.json apps/browser-observer-actor/package.json

RUN pnpm install --frozen-lockfile \
      --filter @b2a/contracts \
      --filter @b2a/scanner-core \
      --filter @b2a/browser-observer-actor

COPY --chown=myuser:myuser packages/contracts packages/contracts
COPY --chown=myuser:myuser packages/scanner-core packages/scanner-core
COPY --chown=myuser:myuser apps/browser-observer-actor apps/browser-observer-actor

RUN pnpm --filter @b2a/contracts build \
    && pnpm --filter @b2a/scanner-core build \
    && pnpm --filter @b2a/browser-observer-actor build

CMD ["node", "apps/browser-observer-actor/dist/index.js"]
