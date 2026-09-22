FROM apify/actor-node-playwright-chrome:24-1.61.1

WORKDIR /home/myuser

USER root
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate
USER myuser

COPY --chown=myuser:myuser package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=myuser:myuser tsconfig.base.json ./
COPY --chown=myuser:myuser packages/scanner-contracts/package.json packages/scanner-contracts/package.json
COPY --chown=myuser:myuser packages/scanner/package.json packages/scanner/package.json
COPY --chown=myuser:myuser apps/browser-observer-actor/package.json apps/browser-observer-actor/package.json

RUN pnpm install --frozen-lockfile --filter @agentify/browser-observer-actor...

COPY --chown=myuser:myuser packages/scanner-contracts packages/scanner-contracts
COPY --chown=myuser:myuser packages/scanner packages/scanner
COPY --chown=myuser:myuser apps/browser-observer-actor apps/browser-observer-actor

RUN pnpm --filter @agentify/scanner-contracts build \
    && pnpm --filter @agentify/scanner build \
    && pnpm --filter @agentify/browser-observer-actor build

CMD ["node", "apps/browser-observer-actor/dist/index.js"]
