# Agentify Browser Observer

This private Actor performs the passive browser observations defined by its
input and output schemas. Its build tag names the version of the browser
observation contract it implements, the same version its input and output
carry, so a build of another version is refused at that version.

Run Actor CLI commands from the repository root. The root `.actor` metadata and
`.actorignore` make the shared workspace lockfile part of the upload context while
limiting the Actor source bundle to its build inputs. The Dockerfile remains in this
directory. Its vendor image tag pins Playwright 1.61.1 and the Node 24 line, so the Node patch version follows the vendor, and the
Dockerfile installs pnpm 11.12.0, matching the root workspace toolchain.
Deployment requires an explicit Actor workflow and is outside local
verification.
