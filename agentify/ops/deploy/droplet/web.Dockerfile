FROM node:24.21.0-alpine AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY agentify/package.json agentify/package.json
COPY agentify/tsconfig.base.json agentify/tsconfig.base.json
COPY agentify/packages/contracts/package.json agentify/packages/contracts/package.json
COPY agentify/packages/db/package.json agentify/packages/db/package.json
COPY agentify/packages/analytics/package.json agentify/packages/analytics/package.json
COPY agentify/packages/observability/package.json agentify/packages/observability/package.json
COPY agentify/packages/scanner-core/package.json agentify/packages/scanner-core/package.json
COPY agentify/packages/remediation/package.json agentify/packages/remediation/package.json
COPY agentify/apps/web/package.json agentify/apps/web/package.json
RUN pnpm install --frozen-lockfile --filter agentify --filter @b2a/web...

FROM dependencies AS builder

ARG NEXT_PUBLIC_APP_BASE_URL=https://agentify.ad
ARG NEXT_PUBLIC_DISPLAY_BRAND=Agentify
ARG NEXT_PUBLIC_REGISTRATION_ENABLED=false
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=
ARG NEXT_PUBLIC_SUPABASE_AUTH_URL=
ARG NEXT_PUBLIC_SUPABASE_AUTH_PUBLISHABLE_KEY=

ENV NODE_ENV=production \
    NEXT_PUBLIC_APP_BASE_URL=$NEXT_PUBLIC_APP_BASE_URL \
    NEXT_PUBLIC_DISPLAY_BRAND=$NEXT_PUBLIC_DISPLAY_BRAND \
    NEXT_PUBLIC_REGISTRATION_ENABLED=$NEXT_PUBLIC_REGISTRATION_ENABLED \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_PUBLIC_SUPABASE_AUTH_URL=$NEXT_PUBLIC_SUPABASE_AUTH_URL \
    NEXT_PUBLIC_SUPABASE_AUTH_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_AUTH_PUBLISHABLE_KEY \
    DATABASE_URL=postgresql://build:build@127.0.0.1/build \
    TOKEN_HMAC_SECRET=build-only-placeholder-secret-000000000000 \
    EMAIL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    EMAIL_PROVIDER=disabled \
    REGISTRATION_ENABLED=false

COPY agentify/packages agentify/packages
COPY agentify/apps/web agentify/apps/web
RUN pnpm --filter @b2a/web build \
  && printf '%s\n' "$NEXT_PUBLIC_REGISTRATION_ENABLED" > /tmp/registration-build-flag \
  && node -e "const {createHash}=require('node:crypto'); process.stdout.write(createHash('sha256').update(process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL+'\\0'+process.env.NEXT_PUBLIC_SUPABASE_AUTH_PUBLISHABLE_KEY).digest('hex')+'\\n')" > /tmp/supabase-auth-build-fingerprint

FROM builder AS privacy-jobs

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@b2a/web", "privacy:cleanup"]

FROM node:24.21.0-alpine AS runner

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

WORKDIR /app
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/agentify/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/agentify/apps/web/.next/static ./agentify/apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/agentify/apps/web/public ./agentify/apps/web/public
COPY --from=builder --chown=nextjs:nodejs /tmp/registration-build-flag /app/.registration-build-flag
COPY --from=builder --chown=nextjs:nodejs /tmp/supabase-auth-build-fingerprint /app/.supabase-auth-build-fingerprint
COPY agentify/ops/deploy/droplet/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/bin/sh", "/usr/local/bin/web-entrypoint.sh"]
CMD ["node", "agentify/apps/web/server.js"]
