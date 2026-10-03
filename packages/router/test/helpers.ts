import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CameraRecord } from "../src/geo.ts";
import type { RoadPack } from "../src/pack.ts";
import { Router } from "../src/router.ts";
import type { Endpoint } from "../src/search.ts";

export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

export function readArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export const hasDallas = existsSync(`${DATA}packs/dallas.fwr`) && existsSync(`${DATA}fixtures/dallas_exposure.json`);

/** The synthetic 5x5 grid: node id = 1 + 5 * row + col, rows south -> north, 200 m blocks. */
export const GRID_NODES = readJson<{ nodes: Record<string, [number, number]> }>(`${FIXTURES}grid.json`).nodes;

export function gridRouter(cameras: CameraRecord[] = []): Router {
  return Router.fromBuffer(readArrayBuffer(`${FIXTURES}grid.fwr`), cameras);
}

/** Point `metres` of the way from grid node a towards node b. */
export function between(a: number, b: number, metres: number): [number, number] {
  const [lon0, lat0] = GRID_NODES[a], [lon1, lat1] = GRID_NODES[b];
  const t = metres / 200;
  return [lon0 + t * (lon1 - lon0), lat0 + t * (lat1 - lat0)];
}

export function at(router: Router, node: number | [number, number]): Endpoint {
  const [lon, lat] = typeof node === "number" ? GRID_NODES[node] : node;
  const p = router.snap(lon, lat, 5);
  if (!p) throw new Error(`nothing to snap to at ${lon},${lat}`);
  return p;
}

/** A grid camera 5 m east of `node`, facing `direction` (OSM tag value). */
export function gridCamera(id: number, node: number, direction: string, brand = "Flock Safety"): CameraRecord {
  const [lon, lat] = GRID_NODES[node];
  const metresPerDegLon = 111_194.93 * Math.cos((lat * Math.PI) / 180);
  return { id, lon: lon + 5 / metresPerDegLon, lat, tags: { direction, manufacturer: brand } };
}

/** Whether a [lon, lat] polyline passes within `tol` metres of grid node `node`. */
export function passes(coords: [number, number][], node: number, pack: RoadPack, tol = 1): boolean {
  const [lon, lat] = GRID_NODES[node];
  const x = pack.proj.x(lon), y = pack.proj.y(lat);
  return coords.some(([a, b]) => Math.hypot(pack.proj.x(a) - x, pack.proj.y(b) - y) <= tol);
}
