# The image three of compose.yaml's services run from: the application (the
# gateway and the dashboard in one process), the mock merchant, and the
# migration that runs to completion before them. Which one a container is is
# decided at `command`, not at build time.
#
# Node runs the TypeScript through tsx, as on a laptop; the one compile step is
# the dashboard's pages, below.

FROM node:24.22.1-alpine

# pnpm is pinned so the install inside the image matches the lockfile.
# COREPACK_HOME is shared and world-readable because corepack caches under the
# home of whoever ran it: a pnpm fetched here as root would be invisible to the
# `node` user, and every container start would fetch it from the network.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable \
  && corepack prepare pnpm@11.12.0 --activate \
  && chmod -R a+rX "${COREPACK_HOME}"

WORKDIR /app

# The dependencies first, off the lockfile alone: `pnpm fetch` reads no
# manifests, so this layer survives every edit to the source below it and is
# rebuilt only when the lockfile moves.
COPY pnpm-lock.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --frozen-lockfile --offline

# The dashboard's pages are the one thing compiled: React Router's Vite build,
# the scripts and styles a browser loads and the server half the process
# imports. Node runs the rest of the source as it is.
RUN pnpm --filter @agentify/dashboard build

# Not root. The application is reached from outside through Caddy, and none of
# the three has any reason to be able to write to its own source.
ARG AGENTIFY_SOURCE_REVISION=unknown
ENV AGENTIFY_SOURCE_REVISION=$AGENTIFY_SOURCE_REVISION
USER node
RUN test -r packages/core/src/deployment/preflight.mjs

# Overridden by compose; named here so the image is runnable on its own.
CMD ["pnpm", "--filter", "@agentify/app", "start"]
