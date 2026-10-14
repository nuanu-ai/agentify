import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

/**
 * Every asset lives under the documentation's prefix and carries a content
 * hash. The framework is one chunk and the shared components another, so that
 * a page's own module is all a move to another page has to fetch.
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
          return /\/packages\/ui\/|\/app\/components\//.test(id) ? "components" : undefined;
        },
      },
    },
  },
});
