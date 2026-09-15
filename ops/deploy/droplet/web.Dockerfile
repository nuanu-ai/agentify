FROM node:24.21.0-alpine AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.scanner.json ./
COPY packages/scanner-contracts/package.json packages/scanner-contracts/package.json
COPY packages/scanner-database/package.json packages/scanner-database/package.json
COPY packages/analytics/package.json packages/analytics/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/scanner/package.json packages/scanner/package.json
COPY packages/remediation/package.json packages/remediation/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @agentify/web...

FROM dependencies AS builder

ARG NEXT_PUBLIC_APP_BASE_URL=https://agentify.ad
ARG NEXT_PUBLIC_DISPLAY_BRAND=Agentify
ARG NEXT_PUBLIC_REGISTRATION_ENABLED=false
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=

ENV NODE_ENV=production \
    NEXT_PUBLIC_APP_BASE_URL=$NEXT_PUBLIC_APP_BASE_URL \
    NEXT_PUBLIC_DISPLAY_BRAND=$NEXT_PUBLIC_DISPLAY_BRAND \
    NEXT_PUBLIC_REGISTRATION_ENABLED=$NEXT_PUBLIC_REGISTRATION_ENABLED \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    DATABASE_URL=postgresql://build:build@127.0.0.1/build \
    TOKEN_HMAC_SECRET=build-only-placeholder-secret-000000000000 \
    EMAIL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    EMAIL_PROVIDER=disabled \
    REGISTRATION_ENABLED=false

COPY packages/scanner-contracts packages/scanner-contracts
COPY packages/scanner-database packages/scanner-database
COPY packages/analytics packages/analytics
COPY packages/observability packages/observability
COPY packages/scanner packages/scanner
COPY packages/remediation packages/remediation
COPY apps/web apps/web
RUN pnpm --filter @agentify/web build \
  && printf '%s\n' "$NEXT_PUBLIC_REGISTRATION_ENABLED" > /tmp/registration-build-flag

FROM builder AS privacy-jobs

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@agentify/web", "privacy:cleanup"]

FROM node:24.21.0-alpine AS runner

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

WORKDIR /app
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /tmp/registration-build-flag /app/.registration-build-flag
COPY ops/deploy/droplet/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/bin/sh", "/usr/local/bin/web-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]
