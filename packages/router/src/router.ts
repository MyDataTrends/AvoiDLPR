/**
 * Public API: load a road pack and a camera feed, then snap, route and budget.
 *
 *   const router = Router.fromBuffer(packBytes, cameraRecords);
 *   const a = router.snap(lon, lat), b = router.snap(lon2, lat2);
 *   router.route(a, b, { lambda: 60 });           // fixed price per capture
 *   router.routeWithinBudget(a, b, { maxExtra: 0.1 }); // fewest captures within +10% time
 *
 * Everything runs locally: origins and destinations never leave the device.
 */

import { buildCameraSet, type CameraSet } from "./cameras.ts";
import { computeExposure, type Exposure } from "./exposure.ts";
import { type Camera, type CameraRecord, captures, PROFILES, type ZoneParams, wrap180 } from "./geo.ts";
import { SegmentGrid } from "./grid.ts";
import { decodePack, type RoadPack } from "./pack.ts";
import { EdgeSearch, type Endpoint, type SearchPath, turnCost } from "./search.ts";

export interface RouteSite {
  site: number;
  /** Metres along the route at which the vehicle enters this site's capture zone. */
  atM: number;
  cameras: Camera[];
}

export interface Route {
  lambda: number;
  /** Search objective: seconds plus lambda per capture-site entry. */
  cost: number;
  /** Estimated driving time: free-flow speeds, signal delay, turn costs. */
  timeS: number;
  distanceM: number;
  /** Heading changes over 45 degrees at intersections. */
  turns: number;
  /** Distinct capture sites logging the route, in the order the vehicle meets them. */
  sites: RouteSite[];
  edges: number[];
  /** [lon, lat] polyline. */
  coordinates: [number, number][];
}

export interface BudgetRoute {
  fastest: Route;
  /** Fewest capture sites among the probed routes within the time budget. */
  chosen: Route;
  lambda: number;
  /** Searches run, the fastest included. */
  probes: number;
}

export interface RouterOptions {
  params?: ZoneParams;
  /** Ignore heading (every camera sees both directions): for comparison only. */
  omni?: boolean;
}

export class Router {
  readonly pack: RoadPack;
  readonly grid: SegmentGrid;
  params: ZoneParams;
  cameras!: CameraSet;
  exposure!: Exposure;
  private readonly omni: boolean;
  private search!: EdgeSearch;

  constructor(pack: RoadPack, records: readonly CameraRecord[], opts: RouterOptions = {}) {
    this.pack = pack;
    this.grid = new SegmentGrid(pack);
    this.params = opts.params ?? PROFILES.default;
    this.omni = opts.omni ?? false;
    this.setCameras(records);
  }

  static fromBuffer(buf: ArrayBuffer, records: readonly CameraRecord[], opts: RouterOptions = {}): Router {
    return new Router(decodePack(buf), records, opts);
  }

  /** Replace the camera feed (hourly refresh, or the user's own report) and recompute exposure. */
  setCameras(records: readonly CameraRecord[], params: ZoneParams = this.params): void {
    this.params = params;
    this.cameras = buildCameraSet(records, this.pack.proj, params, this.omni);
    this.exposure = computeExposure(this.pack, this.grid, this.cameras, params);
    if (this.search) this.search.exposure = this.exposure;
    else this.search = new EdgeSearch(this.pack, this.exposure);
  }

  /** Nearest point on the road network, or null if none is within `maxDistM`. */
  snap(lon: number, lat: number, maxDistM = 250): Endpoint | null {
    const { proj, vx, vy, vs, vertGeom } = this.pack;
    const x = proj.x(lon), y = proj.y(lat);
    const hit = this.grid.nearest(x, y, maxDistM);
    if (!hit) return null;
    const { k, t, dist } = hit;
    const dx = vx[k + 1] - vx[k], dy = vy[k + 1] - vy[k];
    return { geom: vertGeom[k], s: vs[k] + t * Math.hypot(dx, dy), x: vx[k] + t * dx, y: vy[k] + t * dy, offsetM: dist };
  }

  route(from: Endpoint, to: Endpoint, opts: { lambda?: number; heuristic?: boolean } = {}): Route | null {
    const lambda = opts.lambda ?? 0;
    const path = this.search.run(from, to, lambda, opts.heuristic ?? true);
    return path && this.assemble(path, lambda);
  }

  /**
   * Fewest capture sites within `maxExtra` (fraction) more time than the fastest route.
   * A constrained shortest path solved by Lagrangian relaxation: route time only rises as
   * the camera price lambda rises, so bisect lambda (geometrically) for the dearest price
   * whose route still fits the budget.
   */
  routeWithinBudget(from: Endpoint, to: Endpoint,
    opts: { maxExtra?: number; lambdaMax?: number; probes?: number } = {}): BudgetRoute | null {
    const { maxExtra = 0.1, lambdaMax = 1800, probes = 7 } = opts;
    const fastest = this.route(from, to);
    if (!fastest) return null;
    const limit = fastest.timeS * (1 + maxExtra) + 1e-9;
    let chosen = fastest, chosenLambda = 0, runs = 1;
    const take = (r: Route | null, lambda: number): Route | null => {
      runs++;
      if (r && r.timeS <= limit && (r.sites.length < chosen.sites.length
        || (r.sites.length === chosen.sites.length && r.timeS < chosen.timeS))) {
        chosen = r;
        chosenLambda = lambda;
      }
      return r;
    };
    if (fastest.sites.length > 0) {
      const top = take(this.route(from, to, { lambda: lambdaMax }), lambdaMax);
      if (top && top.timeS > limit) {
        let lo = 1, hi = lambdaMax;
        for (let i = 0; i < probes && chosen.sites.length > 0; i++) {
          const mid = Math.sqrt(lo * hi);
          const r = take(this.route(from, to, { lambda: mid }), mid);
          if (r && r.timeS <= limit) lo = mid;
          else hi = mid;
        }
      }
    }
    return { fastest, chosen, lambda: chosenLambda, probes: runs };
  }

  /** Sites whose zone holds a vehicle here on this heading: the live-alert primitive. */
  sitesCapturingAt(lon: number, lat: number, headingDeg: number): number[] {
    const { proj } = this.pack;
    const x = proj.x(lon), y = proj.y(lat), p = this.params;
    const found = new Set<number>();
    for (const i of this.cameras.near(x, y, p.rangeM + p.epsM)) {
      if (captures(this.cameras.cameras[i], x, y, headingDeg, p)) found.add(this.cameras.siteOf[i]);
    }
    return [...found];
  }

  /** Expanded-edge count of the most recent search (for benchmarks). */
  get lastExpanded(): number {
    return this.search.expanded;
  }

  private assemble(path: SearchPath, lambda: number): Route {
    const { pack, exposure } = this;
    const { edgeGeom, edgeRev, edgeTime, edgeH0, edgeH1, geomLen } = pack;
    const { edges } = path;
    let timeS = 0, distanceM = 0, turns = 0;
    const firstAt = new Map<number, number>();
    const coordinates: [number, number][] = [];
    edges.forEach((e, i) => {
      const L = geomLen[edgeGeom[e]];
      const a = i === 0 ? path.startOffset : 0;
      const b = i === edges.length - 1 ? path.endOffset : L;
      if (i > 0) {
        timeS += turnCost(edgeH1[edges[i - 1]], edgeH0[e]);
        if (Math.abs(wrap180(edgeH0[e] - edgeH1[edges[i - 1]])) > 45) turns++;
      }
      if (L > 0) timeS += edgeTime[e] * ((b - a) / L);
      for (let k = exposure.ptr[e]; k < exposure.ptr[e + 1]; k++) {
        if (exposure.entry[k] <= b && exposure.exit[k] >= a && !firstAt.has(exposure.site[k])) {
          firstAt.set(exposure.site[k], distanceM + Math.max(exposure.entry[k], a) - a);
        }
      }
      distanceM += b - a;
      this.appendCoordinates(coordinates, edgeGeom[e], edgeRev[e] === 1, a, b);
    });
    const sites = [...firstAt].sort((x, y) => x[1] - y[1]).map(([site, atM]) => ({
      site, atM, cameras: this.cameras.siteCameras[site].map((c) => this.cameras.cameras[c]),
    }));
    return { lambda, cost: path.cost, timeS, distanceM, turns, sites, edges, coordinates };
  }

  /** Append the stretch [a, b] (metres in travel order) of a geometry as lon/lat points. */
  private appendCoordinates(out: [number, number][], g: number, rev: boolean, a: number, b: number): void {
    const { geomPtr, vx, vy, vs, geomLen, proj } = this.pack;
    const L = geomLen[g];
    const [s0, s1] = rev ? [L - b, L - a] : [a, b];
    const pts: [number, number][] = [];
    const at = (s: number): [number, number] => {
      let k = geomPtr[g];
      while (k + 2 < geomPtr[g + 1] && vs[k + 1] < s) k++;
      const seg = vs[k + 1] - vs[k];
      const t = seg > 0 ? Math.min(1, Math.max(0, (s - vs[k]) / seg)) : 0;
      return [vx[k] + t * (vx[k + 1] - vx[k]), vy[k] + t * (vy[k + 1] - vy[k])];
    };
    pts.push(at(s0));
    for (let k = geomPtr[g]; k < geomPtr[g + 1]; k++) if (vs[k] > s0 && vs[k] < s1) pts.push([vx[k], vy[k]]);
    pts.push(at(s1));
    if (rev) pts.reverse();
    for (const [x, y] of pts) {
      const p: [number, number] = [proj.lon(x), proj.lat(y)];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
  }
}
