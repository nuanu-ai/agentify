/**
 * The last step of `pnpm --filter @agentify/web build`: a compressed copy
 * beside every script and stylesheet the build wrote for the browser. Run after
 * React Router's build rather than inside it, because the route manifest is
 * written by its server half, after the browser's.
 */

import { fileURLToPath } from "node:url";
import { precompress } from "@agentify/ui/assets";

const written = await precompress(fileURLToPath(new URL("../dist/client/assets", import.meta.url)));
console.log(`[web] ${written} scripts and stylesheets written compressed beside themselves`);
