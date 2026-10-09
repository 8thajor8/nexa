import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vitest/config";
import { createContentSecurityPolicy } from "./src/main/security.js";

function contentSecurityPolicyPlugin(): Plugin {
  let development = false;
  return {
    name: "nexa-desktop-content-security-policy",
    configResolved(config) { development = config.command === "serve"; },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return {
          html,
          tags: [{
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: createContentSecurityPolicy(development),
            },
            injectTo: "head",
          }],
        };
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicyPlugin()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
  test: { environment: "node", include: ["test/**/*.test.ts"], clearMocks: true },
});