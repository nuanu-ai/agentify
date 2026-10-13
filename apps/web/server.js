// Starts the built scanner (`pnpm --filter @agentify/web build`): `server/app.ts`
// compiled with React Router's build inside it.
import { serve } from "./dist/server/index.js";

await serve();
