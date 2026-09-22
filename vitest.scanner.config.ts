import { fileURLToPath } from "node:url";

export default {
  root: process.cwd(),
  // Next compiles JSX with the automatic runtime; the tests must use the same
  // one, or a component passes here under a transform production never runs.
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    setupFiles: [fileURLToPath(new URL("./vitest.setup.ts", import.meta.url))],
  },
};
