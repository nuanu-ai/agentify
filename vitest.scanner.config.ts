import { fileURLToPath } from "node:url";

export default {
  root: process.cwd(),
  test: {
    setupFiles: [fileURLToPath(new URL("./vitest.setup.ts", import.meta.url))],
  },
};
