// Starts the built scanner (`pnpm --filter @agentify/web build`): `server/app.ts`
// compiled with React Router's build inside it, given the browser's files.
import { fileURLToPath } from "node:url";
import { serve } from "./dist/server/index.js";

await serve({ client: fileURLToPath(new URL("./dist/client", import.meta.url)) });
