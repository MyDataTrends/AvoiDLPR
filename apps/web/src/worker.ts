// The router lives here, off the main thread: decoding the pack, computing exposure and
// searching never stall the map. The only thing it fetches is the map data it is told to load.
import { type CameraRecord, type PackMeta, PROFILES, RINGS, type Route, type RouteSite, Router, SNAP_MAX_M } from "@flockwatch/router";

import { fetchData, fetchOk } from "./fetch-data.ts";
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
  const pairs = (sectors: readonly (readonly [number, number])[]) => sectors.map(([b, h]) => [b, h] as [number, number]);
  cams = r.cameras.cameras.map((c, i) => ({
    osmId: c.osmId, lon: c.lon, lat: c.lat, brand: c.brand, mode: c.mode,
    sectors: pairs(c.sectors), ring: pairs(r.ringCameras?.cameras[i].sectors ?? []), site: r.cameras.siteOf[i],
  }));
  siteIndex = new Map(r.cameras.siteCameras.map((m, s) => [s, m]));
}

function toDTO(r: Route): RouteDTO {
  const site = (s: RouteSite) => ({
    site: s.site, atM: s.atM, untilM: s.untilM, cameras: (siteIndex.get(s.site) ?? []).map((i) => cams[i]),
  });
  return {
    timeS: r.timeS, distanceM: r.distanceM, turns: r.turns, coordinates: r.coordinates,
    sites: r.sites.map(site), near: r.near.map(site),
  };
}

function ready(r: Router): void {
  const meta: PackMeta = r.pack.meta;
  refreshCameras(r);
  scope.postMessage({
    type: "ready",
    cameras: cams,
    zone: r.params,
    ring: r.ring,
    pack: { url: loaded.url, fellBack: loaded.fellBack, failed: loaded.failed },
    stats: {
      nodes: r.pack.nNodes, edges: r.pack.nEdges, cameras: cams.length, sites: r.cameras.siteCameras.length,
      packMB: loaded.packMB, loadMs: loaded.loadMs, source: meta.source, builtAt: meta.built_at, bbox: meta.bbox,
      lat0: meta.lat0, lon0: meta.lon0, osmAt: (meta as { osm_at?: string }).osm_at, camerasAt,
    },
  });
}

async function fetchFeed(url: string): Promise<Feed> {
  // The camera feed changes hourly: revalidated on every load (a cheap 304 when nothing changed).
  return fetchOk(url, { cache: "no-cache" }).then((r) => r.json() as Promise<Feed>);
}

/** Download, check and decode a pack: the router, or an error saying what went wrong. */
async function openPack(url: string, bytes: number, sha256: string | undefined, params: ProfileName): Promise<Router> {
  const pack = await fetchData(url, bytes, sha256, "road map", (p) => scope.postMessage({ type: "progress", ...p }));
  loaded.packMB = pack.byteLength / 1e6;
  return Router.fromBuffer(pack, records, { params: PROFILES[params], ring: RINGS[params] });
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
      router.setCameras(records, PROFILES[msg.profile], RINGS[msg.profile]);
      ready(router);
    } else if (msg.type === "route") {
      // A place found by search can sit back from the road (the middle of a park or an airport),
      // so the page asks for a wider look there than for a tap on the map.
      const reach = [msg.snapM?.[0] || SNAP_MAX_M, msg.snapM?.[1] || SNAP_MAX_M];
      const a = router.snap(msg.from[0], msg.from[1], reach[0]);
      const b = router.snap(msg.to[0], msg.to[1], reach[1]);
      if (!a || !b) {
        scope.postMessage({
          type: "noroute", id: msg.id,
          reason: `There's no road near the ${a ? "destination" : "start"} (none within ${reach[a ? 1 : 0]} m). Try a spot closer to a street.`,
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
      scope.postMessage({
        type: "capturing", id: msg.id,
        sites: router.sitesCapturingAt(msg.lon, msg.lat, msg.heading), near: router.sitesNearAt(msg.lon, msg.lat, msg.heading),
      });
    }
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
