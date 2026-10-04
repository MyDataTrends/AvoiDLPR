// Serve a staged release directory (see pipeline/release.py) over HTTP, with the behaviour the
// app relies on from real object storage: byte-range reads (PMTiles fetches tiles as ranges),
// sensible content types, and cache headers that match how files are published.
//
// Used three ways: as middleware in the dev and preview servers (so local runs use the production
// layout), and by serve-release.ts as a stand-in for the bucket (with CORS, to test a data host on
// a different origin).
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

/** URL prefixes that belong to the release; everything else is the app's own. */
export const RELEASE_PATHS = /^(regions\.json$|(packs|cameras|basemap)\/)/;

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".pbf": "application/x-protobuf",
  ".png": "image/png",
  ".fwr": "application/octet-stream",
  ".pmtiles": "application/octet-stream",
};

/** Content-hashed files (<region>.<10 hex>.<ext>) and fonts/sprites never change; the rest does. */
function cacheControl(rel: string): string {
  if (/^(packs|basemap)\/[^/]+\.[0-9a-f]{10}\.(fwr|pmtiles)$/.test(rel) || rel.startsWith("basemap/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=0, must-revalidate";
}

export interface Options {
  /** Allow any origin to read (as the bucket's CORS rule does). */
  cors?: boolean;
}

/** Handle a request if it names a file in `dir`; returns false (and does nothing) if it doesn't. */
export function serveRelease(req: IncomingMessage, res: ServerResponse, dir: string, opts: Options = {}): boolean {
  const method = req.method ?? "GET";
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
  if (opts.cors) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "range, if-match, if-none-match");
    res.setHeader("Access-Control-Expose-Headers", "etag, content-range, content-length, accept-ranges");
    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return true;
    }
  }
  if ((method !== "GET" && method !== "HEAD") || !RELEASE_PATHS.test(rel)) return false;
  const root = resolve(dir);
  const file = resolve(root, rel);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return false;

  const { size, mtimeMs } = statSync(file);
  const etag = `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
  res.setHeader("Cache-Control", cacheControl(rel));
  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.end();
    return true;
  }

  let start = 0, end = size - 1;
  const asked = req.headers.range;
  if (asked) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(asked);
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(m[2])); // the last N bytes
      }
      if (start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return true;
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    }
  }
  res.setHeader("Content-Length", end - start + 1);
  if (method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
  return true;
}
