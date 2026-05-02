import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { siteBasePath, siteOrigin } from "./site-config.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  site: siteOrigin,
  base: siteBasePath,
  trailingSlash: "always",
  vite: {
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
  },
});
