import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

// Road packs, the camera feed and the basemap live in the repo's gitignored data/ directory
// (see README); serving it as the public dir keeps large generated files out of the source tree.
export default defineConfig({
  publicDir: fileURLToPath(new URL("../../data", import.meta.url)),
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  worker: { format: "es" },
  // MapLibre alone is ~1 MB minified (300 kB gzip); that's the floor for a vector map.
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
});
