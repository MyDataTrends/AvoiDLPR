/**
 * Camera exposure per directed edge, computed on the device. Cameras are not baked into the
 * road pack: a fresh camera feed or a user's own report changes routing immediately.
 *
 * Mirrors spike/routing/exposure.py: road polylines are sampled every `stepM` metres; each
 * sample has a position, the heading of its segment and the road length it stands for. For
 * each site, samples near its cameras are tested with `captures` heading forward and
 * reversed (a sample logged by several cameras of one site counts once). Per (edge, site):
 *
 *   entry / exit  where the capture starts and ends, metres from the edge's start
 *   units         min(1, captured length / L_ref), the spike's length-normalised exposure
 *   atEnd         the zone still holds the vehicle at the edge's end, so a continuing edge
 *                 is not charged for the same site again
 *
 * Only roads within R + eps of a camera are touched: about 1.6k cameras in Dallas take
 * tens of milliseconds.
 */

import type { CameraSet } from "./cameras.ts";
import { captures, compassBearing, type ZoneParams, zoneReferenceLength } from "./geo.ts";
import type { SegmentGrid } from "./grid.ts";
import type { RoadPack } from "./pack.ts";

export interface Exposure {
  params: ZoneParams;
  /** CSR over edges: entries ptr[e] .. ptr[e + 1] - 1, sorted by site. */
  ptr: Uint32Array;
  site: Uint32Array;
  entry: Float32Array;
  exit: Float32Array;
  units: Float32Array;
  atEnd: Uint8Array;
  /** What entering the row's zone costs, in captures: 1, or split with a ring (`withRings`). */
  weight: Float32Array;
}

const END_TOLERANCE_M = 0.05;

export function computeExposure(pack: RoadPack, grid: SegmentGrid, cams: CameraSet, params: ZoneParams,
  stepM = 5): Exposure {
  const { vx, vy, vs, vertGeom, geomPtr, geomLen, geomFwd, geomRev } = pack;
  const reach = params.rangeM + params.epsM;

  // Last segment of each geometry that is long enough to have a heading: it also carries
  // the zero-weight sample at the geometry's far end.
  const lastSeg = new Int32Array(pack.nGeoms).fill(-1);
  for (let g = 0; g < pack.nGeoms; g++) {
    for (let k = geomPtr[g + 1] - 2; k >= geomPtr[g]; k--) {
      if (Math.hypot(vx[k + 1] - vx[k], vy[k + 1] - vy[k]) > 0.01) {
        lastSeg[g] = k;
        break;
      }
    }
  }

  const rows: { edge: number; site: number; entry: number; exit: number; units: number; atEnd: number }[] = [];
  cams.siteCameras.forEach((members, site) => {
    const credited = new Set<number>();
    const perEdge = new Map<number, { entry: number; exit: number; len: number }>();
    const credit = (edge: number, along: number, weight: number) => {
      const acc = perEdge.get(edge);
      if (!acc) perEdge.set(edge, { entry: along, exit: along, len: weight });
      else {
        acc.entry = Math.min(acc.entry, along);
        acc.exit = Math.max(acc.exit, along);
        acc.len += weight;
      }
    };
    let lRef = 0;
    for (const ci of members) {
      const cam = cams.cameras[ci];
      lRef = Math.max(lRef, zoneReferenceLength(cam, params));
      grid.forEachNear(cam.x, cam.y, reach, (k) => {
        const ax = vx[k], ay = vy[k], dx = vx[k + 1] - ax, dy = vy[k + 1] - ay;
        const len = Math.hypot(dx, dy);
        if (len <= 0.01) return;
        const g = vertGeom[k];
        const heading = compassBearing(dx, dy);
        const n = Math.max(1, Math.ceil(len / stepM));
        const last = lastSeg[g] === k ? n : n - 1;
        for (let j = 0; j <= last; j++) {
          const t = j / n;
          const px = j === n ? ax + dx : ax + t * dx;
          const py = j === n ? ay + dy : ay + t * dy;
          if ((px - cam.x) ** 2 + (py - cam.y) ** 2 > reach * reach) continue;
          const s = j === n ? vs[k] + len : vs[k] + t * len;
          const weight = j === n ? 0 : len / n;
          for (let dir = 0; dir < 2; dir++) {
            const edge = dir === 0 ? geomFwd[g] : geomRev[g];
            if (edge < 0) continue;
            const id = (k * 1_048_576 + j) * 2 + dir;
            if (credited.has(id) || !captures(cam, px, py, dir === 0 ? heading : heading + 180, params)) continue;
            credited.add(id);
            credit(edge, dir === 0 ? s : geomLen[g] - s, weight);
          }
        }
      });
    }
    for (const [edge, acc] of perEdge) {
      const atEnd = acc.exit >= geomLen[pack.edgeGeom[edge]] - END_TOLERANCE_M ? 1 : 0;
      rows.push({ edge, site, entry: acc.entry, exit: acc.exit, units: Math.min(1, acc.len / lRef), atEnd });
    }
  });

  rows.sort((a, b) => a.edge - b.edge || a.site - b.site);
  const ptr = new Uint32Array(pack.nEdges + 1);
  for (const r of rows) ptr[r.edge + 1]++;
  for (let e = 0; e < pack.nEdges; e++) ptr[e + 1] += ptr[e];
  return {
    params,
    ptr,
    site: Uint32Array.from(rows, (r) => r.site),
    entry: Float32Array.from(rows, (r) => r.entry),
    exit: Float32Array.from(rows, (r) => r.exit),
    units: Float32Array.from(rows, (r) => r.units),
    atEnd: Uint8Array.from(rows, (r) => r.atEnd),
    weight: new Float32Array(rows.length).fill(1),
  };
}

/**
 * Zones and their rings (see RINGS) in one table, for the search. A ring's rows are numbered
 * after the zones' sites (site + nSites), so neither carries over for the other at an
 * intersection, and weighted so a pass through a zone still costs one capture (`ringWeight`
 * for its ring, the rest for the zone) and a pass through a ring alone costs `ringWeight`.
 */
export function withRings(zones: Exposure, rings: Exposure, nSites: number, ringWeight: number): Exposure {
  const nEdges = zones.ptr.length - 1;
  const ptr = new Uint32Array(nEdges + 1);
  for (let e = 0; e < nEdges; e++) {
    ptr[e + 1] = ptr[e] + (zones.ptr[e + 1] - zones.ptr[e]) + (rings.ptr[e + 1] - rings.ptr[e]);
  }
  const n = ptr[nEdges];
  const out: Exposure = {
    params: zones.params, ptr, site: new Uint32Array(n), entry: new Float32Array(n), exit: new Float32Array(n),
    units: new Float32Array(n), atEnd: new Uint8Array(n), weight: new Float32Array(n),
  };
  for (let e = 0; e < nEdges; e++) {
    let o = ptr[e];
    for (const [src, offset, weight] of [[zones, 0, 1 - ringWeight], [rings, nSites, ringWeight]] as const) {
      for (let k = src.ptr[e]; k < src.ptr[e + 1]; k++, o++) {
        out.site[o] = src.site[k] + offset;
        out.entry[o] = src.entry[k];
        out.exit[o] = src.exit[k];
        out.units[o] = src.units[k];
        out.atEnd[o] = src.atEnd[k];
        out.weight[o] = weight;
      }
    }
  }
  return out;
}
