/**
 * The last step of `pnpm --filter @agentify/docs build`: a compressed copy
 * beside every script and stylesheet the build wrote, which Caddy sends to a
 * browser that accepts it rather than compressing on each request.
 */

import { fileURLToPath } from "node:url";
import { precompress } from "@agentify/ui/assets";

const written = await precompress(fileURLToPath(new URL("../dist/client/assets", import.meta.url)));
console.log(`[docs] ${written} scripts and stylesheets written compressed beside themselves`);
