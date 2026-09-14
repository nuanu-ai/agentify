# Agentify Browser Observer

This private Actor performs the passive browser observations defined by its
input and output schemas. Its public identity and build tag remain unchanged
during repository consolidation.

Builds use `agentify/` as the Actor context and the Dockerfile in this
directory. Its pinned vendor image currently provides Node 24.21.0, and the
Dockerfile installs pnpm 11.12.0. Host and CI workspace checks use Node
24.18.x. Deployment requires an explicit Actor workflow and is outside local
verification.
