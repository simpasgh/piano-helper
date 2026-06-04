import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Two HTML entry points: the player (index.html) and the admin feature-flag page (admin.html).
// Cloudflare Pages serves dist/admin.html at /admin automatically (static file routing, no redirect).
// Only `build` is configured here, so Vitest (which also loads this file) keeps its defaults and the
// per-file `// @vitest-environment` directives.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        admin: fileURLToPath(new URL("./admin.html", import.meta.url)),
      },
    },
  },
});
