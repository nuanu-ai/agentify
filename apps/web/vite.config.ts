import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

/**
 * The server half of the build is the scanner's whole process: `server/app.ts`
 * with React Router's build inside it and every package it imports bundled
 * in, so the image runs `dist` with Node and installs nothing beside it. Only
 * the build bundles: compiled from source for a developer or a test, packages
 * are loaded from `node_modules` as they are.
 */
export default defineConfig(({ command }) => ({
  plugins: [reactRouter()],
  // The renderer the server draws pictures with is WebAssembly, imported with
  // `?inline` so the build carries it as data; Vite inlines only what it
  // counts as an asset.
  assetsInclude: ["**/*.wasm"],
  build: {
    assetsInlineLimit: 0,
    // Kept for the speed budget, which reads from it which chunk a page can
    // load later; nothing serves it.
    manifest: true,
  },
  environments: {
    ssr: {
      build: { rollupOptions: { input: "./server/app.ts" } },
      ...(command === "build" ? { resolve: { noExternal: true } } : {}),
    },
  },
}));
