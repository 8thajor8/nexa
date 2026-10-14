import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vitest/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

function localVadAssetsPlugin(): Plugin {
  const files = ["silero_vad_v6.onnx", "vad.worklet.bundle.min.js",
    "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];
  return {
    name: "nexa-local-vad-assets",
    generateBundle() {
      for (const name of files) {
        const packageName = name.startsWith("ort-") ? "onnxruntime-web" : "@ricky0123/vad-web";
        const source = resolve(import.meta.dirname, "node_modules", packageName, "dist", name);
        this.emitFile({ type: "asset", fileName: `vad/${name}`, source: readFileSync(source) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicyPlugin(), localVadAssetsPlugin()],
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
  test: { environment: "node", include: ["test/**/*.test.{ts,tsx}"], clearMocks: true },
});
