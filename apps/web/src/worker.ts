// The router lives here, off the main thread: decoding the pack, computing exposure and
// searching never stall the map. Nothing in this worker talks to anything but this origin.
import { type CameraRecord, type PackMeta, PROFILES, type Route, Router } from "@flockwatch/router";

import type { CameraDTO, ProfileName, Request, Response, RouteDTO } from "./protocol.ts";

const scope = self as unknown as {
  postMessage(msg: Response): void;
  onmessage: ((ev: MessageEvent<Request>) => void) | null;
};

let router: Router | null = null;
let records: CameraRecord[] = [];
let loaded: { packMB: number; loadMs: number } = { packMB: 0, loadMs: 0 };
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
    stats: {
      nodes: r.pack.nNodes, edges: r.pack.nEdges, cameras: cams.length, sites: r.cameras.siteCameras.length,
      packMB: loaded.packMB, loadMs: loaded.loadMs, source: meta.source, builtAt: meta.built_at, bbox: meta.bbox,
      lat0: meta.lat0, lon0: meta.lon0,
    },
  });
}

async function fetchOk(url: string): Promise<globalThis.Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

scope.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "load") {
      const t0 = performance.now();
      const [pack, feed] = await Promise.all([
        fetchOk(msg.packUrl).then((r) => r.arrayBuffer()),
        fetchOk(msg.camerasUrl).then((r) => r.json() as Promise<{ cameras: CameraRecord[] }>),
      ]);
      records = feed.cameras;
      router = Router.fromBuffer(pack, records, { params: PROFILES[msg.profile as ProfileName] });
      loaded = { packMB: pack.byteLength / 1e6, loadMs: performance.now() - t0 };
      ready(router);
      return;
    }
    if (!router) throw new Error("router not loaded yet");
    if (msg.type === "profile") {
      router.setCameras(records, PROFILES[msg.profile]);
      ready(router);
    } else if (msg.type === "route") {
      const a = router.snap(msg.from[0], msg.from[1]);
      const b = router.snap(msg.to[0], msg.to[1]);
      if (!a || !b) {
        scope.postMessage({
          type: "noroute", id: msg.id,
          reason: `There's no road within 250 m of the ${a ? "destination" : "start"}. Try a spot closer to a street.`,
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
