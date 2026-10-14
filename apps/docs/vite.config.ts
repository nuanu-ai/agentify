import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

/**
 * Every asset lives under the documentation's prefix and carries a content
 * hash. The framework is one chunk and what the root and the page draw with
 * another, so that a page's own module is all a move to another page has to
 * fetch, and a first visit asks for as few files as it can: over HTTP/1.1 a
 * browser opens six connections to a host, and a stylesheet asked for after
 * six scripts waits for one of them to finish.
 */
export default defineConfig({
  base: "/docs/",
  plugins: [reactRouter()],
  build: {
    assetsInlineLimit: 0,
    // Kept for the speed budget, which reads from it which chunk a page can
    // load later; nothing serves it.
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](?:react|react-dom|react-router|scheduler)[\\/]/.test(id)) {
            return "framework";
          }
          // What the root and every page draw with, the part Caddy fills among it.
          return /\/packages\/(?:ui|core)\/|\/app\/(?:components\/|served|site-values|head)/.test(
            id,
          )
            ? "components"
            : undefined;
        },
      },
    },
  },
});
