// The router lives here, off the main thread: decoding the pack, computing exposure and
// searching never stall the map. The only thing it fetches is the map data it is told to load.
import { type CameraRecord, type PackMeta, PROFILES, type Route, Router, SNAP_MAX_M } from "@flockwatch/router";

import type { CameraDTO, ProfileName, Request, Response, RouteDTO } from "./protocol.ts";

const scope = self as unknown as {
  postMessage(msg: Response): void;
  onmessage: ((ev: MessageEvent<Request>) => void) | null;
};

let router: Router | null = null;
let records: CameraRecord[] = [];
let camerasAt: string | undefined;
let loaded: { packMB: number; loadMs: number; url: string; fellBack: boolean; failed?: string } = {
  packMB: 0, loadMs: 0, url: "", fellBack: false,
};

interface Feed {
  cameras: CameraRecord[];
  built_at?: string;
}
/** Camera DTOs and their site grouping, rebuilt whenever the router's cameras change. */
let cams: CameraDTO[] = [];
let siteIndex = new Map<number, number[]>();

function refreshCameras(r: Router): void {
  cams = r.cameras.cameras.map((c, i) => ({
    osmId: c.osmId, lon: c.lon, lat: c.lat, brand: c.brand, mode: c.mode,
    sectors: c.sectors.map(([b, h]) => [b, h] as [number, number]), site: r.cameras.siteOf[i],
  }));
  siteIndex = new Map(r.cameras.siteCameras.map((m, s) => [s, m]));
}

function toDTO(r: Route): RouteDTO {
  return {
    timeS: r.timeS, distanceM: r.distanceM, turns: r.turns, coordinates: r.coordinates,
    sites: r.sites.map((s) => ({
      site: s.site, atM: s.atM, untilM: s.untilM, cameras: (siteIndex.get(s.site) ?? []).map((i) => cams[i]),
    })),
  };
}

function ready(r: Router): void {
  const meta: PackMeta = r.pack.meta;
  refreshCameras(r);
  scope.postMessage({
    type: "ready",
    cameras: cams,
    zone: r.params,
    pack: { url: loaded.url, fellBack: loaded.fellBack, failed: loaded.failed },
    stats: {
      nodes: r.pack.nNodes, edges: r.pack.nEdges, cameras: cams.length, sites: r.cameras.siteCameras.length,
      packMB: loaded.packMB, loadMs: loaded.loadMs, source: meta.source, builtAt: meta.built_at, bbox: meta.bbox,
      lat0: meta.lat0, lon0: meta.lon0, osmAt: (meta as { osm_at?: string }).osm_at, camerasAt,
    },
  });
}

async function hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchFeed(url: string): Promise<Feed> {
  // The camera feed changes hourly: revalidated on every load (a cheap 304 when nothing changed).
  return fetchOk(url, { cache: "no-cache" }).then((r) => r.json() as Promise<Feed>);
}

/** Download, check and decode a pack: the router, or an error saying what went wrong. */
async function openPack(url: string, bytes: number, sha256: string | undefined, params: ProfileName): Promise<Router> {
  const pack = await fetchPack(url, bytes, sha256);
  loaded.packMB = pack.byteLength / 1e6;
  return Router.fromBuffer(pack, records, { params: PROFILES[params] });
}

async function fetchOk(url: string, init?: RequestInit): Promise<globalThis.Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/**
 * Download a road pack, reporting progress, and un-gzip it. Packs are published gzipped (a third
 * of the size); a host or proxy that already decoded it hands over the plain pack, so the gzip
 * magic bytes decide, not the file name.
 */
async function fetchPack(url: string, expectedBytes: number, sha256?: string): Promise<ArrayBuffer> {
  const res = await fetchOk(url);
  const total = expectedBytes || Number(res.headers.get("content-length")) || 0;
  const chunks: Uint8Array[] = [];
  let loaded = 0, lastReport = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - lastReport > 150) {
      lastReport = now;
      scope.postMessage({ type: "progress", loaded, total });
    }
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  // The manifest's checksum is of the file as published. (crypto.subtle exists on secure pages
  // only; an insecure dev page skips the check.)
  if (sha256 && globalThis.crypto?.subtle && (await hex(bytes)) !== sha256) {
    throw new Error("the road map arrived damaged (its checksum doesn't match)");
  }
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.buffer;
  scope.postMessage({ type: "progress", loaded, total: loaded, unpacking: true });
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

scope.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "load") {
      const t0 = performance.now();
      const feed = await fetchFeed(msg.camerasUrl);
      records = feed.cameras;
      camerasAt = feed.built_at;
      // A new pack that won't download, doesn't match its checksum or doesn't decode gives way to
      // the last one that worked, which the service worker still has.
      let next: Router;
      loaded = { packMB: 0, loadMs: 0, url: msg.packUrl, fellBack: false };
      try {
        next = await openPack(msg.packUrl, msg.packBytes, msg.packSha256, msg.profile);
      } catch (err) {
        if (!msg.fallback) {
          scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err), badPack: msg.packUrl });
          return;
        }
        console.warn(`road map ${msg.packUrl} failed (${err instanceof Error ? err.message : err}); using ${msg.fallback.url}`);
        loaded = { packMB: 0, loadMs: 0, url: msg.fallback.url, fellBack: true, failed: msg.packUrl };
        next = await openPack(msg.fallback.url, 0, msg.fallback.sha256, msg.profile);
      }
      router = next;
      loaded.loadMs = performance.now() - t0;
      ready(router);
      return;
    }
    if (!router) throw new Error("router not loaded yet");
    if (msg.type === "cameras") {
      const feed = await fetchFeed(msg.camerasUrl);
      records = feed.cameras;
      camerasAt = feed.built_at;
      router.setCameras(records);
      ready(router);
      return;
    }
    if (msg.type === "profile") {
      router.setCameras(records, PROFILES[msg.profile]);
      ready(router);
    } else if (msg.type === "route") {
      const a = router.snap(msg.from[0], msg.from[1]);
      const b = router.snap(msg.to[0], msg.to[1]);
      if (!a || !b) {
        scope.postMessage({
          type: "noroute", id: msg.id,
          reason: `There's no road near the ${a ? "destination" : "start"} (none within ${SNAP_MAX_M} m). Try a spot closer to a street.`,
        });
        return;
      }
      const t0 = performance.now();
      const res = router.routeAlternatives(a, b);
      const ms = performance.now() - t0;
      if (!res) {
        scope.postMessage({ type: "noroute", id: msg.id, reason: "No drivable route between these points." });
        return;
      }
      scope.postMessage({
        type: "route", id: msg.id, ms, probes: res.probes, recommended: res.recommended, routes: res.routes.map(toDTO),
      });
    } else if (msg.type === "capturing") {
      scope.postMessage({ type: "capturing", id: msg.id, sites: router.sitesCapturingAt(msg.lon, msg.lat, msg.heading) });
    }
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
