# Agentify Browser Observer

This private Actor performs the passive browser observations defined by its
input and output schemas. Its public identity and build tag remain unchanged
during repository consolidation.

Run Actor CLI commands from the repository root. The root `.actor` metadata and
`.actorignore` make the shared workspace lockfile part of the upload context while
limiting the Actor source bundle to its build inputs. The Dockerfile remains in this
directory. Its pinned vendor image currently provides Node 24.21.0, and the
Dockerfile installs pnpm 11.12.0, matching the root workspace toolchain.
Deployment requires an explicit Actor workflow and is outside local
verification.
