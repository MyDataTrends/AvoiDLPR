import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv, type Plugin } from "vite";

import { serveRelease } from "./scripts/release-files.ts";

const APP = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(APP, "../..");
/** The staged release (python -m pipeline.release): what the dev and phone servers serve as data. */
const RELEASE = process.env.FW_RELEASE_DIR ?? join(ROOT, "release");

/**
 * Serve the release directory at the site root in dev and in `vite preview`, so local runs use
 * the production layout. In production the same paths are served from object storage, via
 * VITE_DATA_BASE, and this plugin does nothing.
 */
function releaseFiles(): Plugin {
  const handler = (req: Parameters<typeof serveRelease>[0], res: Parameters<typeof serveRelease>[1], next: () => void) => {
    if (!serveRelease(req, res, RELEASE)) next();
  };
  return {
    name: "flockwatch-release-files",
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/**
 * The Cloudflare Pages / Netlify `_headers` file. Its Content-Security-Policy confines the app to
 * its own origin plus the data host, so "nothing leaves your device" is enforced by the browser,
 * not just promised. `dataOrigin` is the bucket's origin, when data is served from elsewhere.
 */
function headersFile(dataOrigin: string | null): string {
  const data = dataOrigin ? ` ${dataOrigin}` : "";
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${data}`,
    "font-src 'self'",
    `connect-src 'self'${data}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return [
    "/*",
    `  Content-Security-Policy: ${csp}`,
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "  Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=()",
    "",
    "/",
    "  Cache-Control: no-cache",
    "/index.html",
    "  Cache-Control: no-cache",
    "/sw.js",
    "  Cache-Control: no-cache",
    "/manifest.webmanifest",
    "  Cache-Control: public, max-age=3600",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n");
}

/**
 * Build-time PWA pieces: the service worker (its template plus the list of files to precache and
 * a version that changes whenever any of them does) and the `_headers` file. Under `vite preview`
 * it also applies the `/*` headers to every response, so the CSP gets exercised locally.
 */
function pwa(dataOrigin: string | null): Plugin {
  let outDir = "dist";
  return {
    name: "flockwatch-pwa",
    configResolved: (config) => void (outDir = resolve(config.root, config.build.outDir)),
    generateBundle(_options, bundle) {
      const publicDir = join(APP, "public");
      const publicFiles = existsSync(publicDir) ? walk(publicDir).map((f) => relative(publicDir, f).split("\\").join("/")) : [];
      const emitted = Object.keys(bundle).filter((f) => !f.endsWith(".map"));
      const shell = ["/", ...new Set([...emitted, ...publicFiles].filter((f) => f !== "_headers").map((f) => `/${f}`))].sort();
      const hash = createHash("sha256");
      for (const f of shell) hash.update(f);
      for (const f of publicFiles) hash.update(readFileSync(join(publicDir, f)));
      const version = hash.digest("hex").slice(0, 12);
      const template = readFileSync(join(APP, "sw", "sw.template.js"), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template.replace('"__VERSION__"', JSON.stringify(version)).replace("__SHELL__", JSON.stringify(shell)),
      });
      this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(dataOrigin) });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        const file = join(outDir, "_headers");
        const block = existsSync(file) ? /^\/\*\n((?: {2}.+\n)+)/m.exec(readFileSync(file, "utf8")) : null;
        for (const line of block?.[1].split("\n") ?? []) {
          const m = /^ {2}([\w-]+): (.+)$/.exec(line);
          if (m) res.setHeader(m[1], m[2]);
        }
        next();
      });
    },
  };
}

/** The origin of VITE_DATA_BASE, or null when it is empty or a path on this origin. */
function originOf(base: string | undefined): string | null {
  try {
    return base ? new URL(base).origin : null;
  } catch {
    return null;
  }
}

export default defineConfig(({ mode }) => {
  // VITE_DATA_BASE: where regions.json, packs/, cameras/ and basemap/ are served from. Empty means
  // this origin (dev, `npm run phone`); in production it's the bucket's public URL.
  const dataOrigin = originOf(loadEnv(mode, APP, "VITE_").VITE_DATA_BASE);
  return {
    plugins: [releaseFiles(), pwa(dataOrigin)],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    worker: { format: "es" },
    // MapLibre alone is ~1 MB minified (300 kB gzip); that's the floor for a vector map.
    build: { target: "es2022", chunkSizeWarningLimit: 1200 },
  };
});
