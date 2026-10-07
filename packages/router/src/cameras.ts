/**
 * Cameras and capture sites. A site is a cluster of co-located cameras (a pole, a per-lane
 * gantry): passing it records you once however many lenses it has, so the site is the
 * privacy unit for both routing cost and the alerts a driver sees.
 */

import { type Camera, type CameraRecord, cameraFromRecord, type LocalProjection, type ZoneParams } from "./geo.ts";

export interface CameraSet {
  cameras: Camera[];
  /** Site index per camera. Sites are numbered by their lowest camera index. */
  siteOf: Int32Array;
  /** Camera indices per site. */
  siteCameras: number[][];
  /** Cameras whose position is within `r` metres of (x, y). */
  near(x: number, y: number, r: number): number[];
}

/**
 * Union cameras within `radiusM` of each other (transitively). Lanes are ~3.7 m apart and
 * multi-camera poles are mapped a few metres apart, so 25 m merges installations without
 * merging neighbouring intersections.
 */
export function clusterSites(cams: readonly Camera[], radiusM = 25): Int32Array {
  const parent = Int32Array.from(cams.keys());
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const cells = bucket(cams, radiusM);
  cams.forEach((a, i) => {
    const cx = Math.floor(a.x / radiusM), cy = Math.floor(a.y / radiusM);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of cells.get(key(cx + dx, cy + dy)) ?? []) {
          if (j <= i || Math.hypot(cams[j].x - a.x, cams[j].y - a.y) > radiusM) continue;
          const ri = root(i), rj = root(j);
          parent[Math.max(ri, rj)] = Math.min(ri, rj);
        }
      }
    }
  });
  const roots = cams.map((_, i) => root(i));
  const rank = new Map([...new Set(roots)].sort((a, b) => a - b).map((r, s) => [r, s]));
  return Int32Array.from(roots, (r) => rank.get(r)!);
}

export function buildCameraSet(records: readonly CameraRecord[], proj: LocalProjection, p: ZoneParams,
  omni = false): CameraSet {
  const cameras = records.map((r) => cameraFromRecord(r, proj, p, omni));
  const siteOf = clusterSites(cameras);
  const siteCameras: number[][] = [];
  siteOf.forEach((s, i) => (siteCameras[s] ??= []).push(i));
  const cellM = 100;
  const cells = bucket(cameras, cellM);
  const near = (x: number, y: number, r: number): number[] => {
    const out: number[] = [];
    for (let cx = Math.floor((x - r) / cellM); cx <= Math.floor((x + r) / cellM); cx++) {
      for (let cy = Math.floor((y - r) / cellM); cy <= Math.floor((y + r) / cellM); cy++) {
        for (const i of cells.get(key(cx, cy)) ?? []) {
          if (Math.hypot(cameras[i].x - x, cameras[i].y - y) <= r) out.push(i);
        }
      }
    }
    return out;
  };
  return { cameras, siteOf, siteCameras, near };
}

/**
 * The same cameras and sites as `zones` (built from the same records), with a ring's sectors,
 * seeing either way along their axis: see RINGS.
 */
export function ringCameraSet(zones: CameraSet, records: readonly CameraRecord[], proj: LocalProjection, ring: ZoneParams,
  omni = false): CameraSet {
  return { ...zones, cameras: records.map((r) => cameraFromRecord(r, proj, ring, omni, true)) };
}

function key(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

function bucket(cams: readonly Camera[], cellM: number): Map<string, number[]> {
  const cells = new Map<string, number[]>();
  cams.forEach((c, i) => {
    const k = key(Math.floor(c.x / cellM), Math.floor(c.y / cellM));
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  });
  return cells;
}
