/**
 * Road pack (FWR1) decoder. Format and rationale: pipeline/pack.py.
 *
 * Sections map onto typed arrays without copying. Derived on load: projected vertex
 * coordinates, distance along each geometry, node positions, twin edges and the
 * banned-turn lookup.
 *
 * The road labels turn-by-turn directions use (`labels`, `geom_label`, `geom_flags`) came later:
 * a pack without them decodes with every road unnamed.
 */

import { LocalProjection } from "./geo.ts";

type DType = "uint8" | "uint16" | "int32" | "uint32" | "float32" | "float64";

interface SectionInfo {
  name: string;
  dtype: DType;
  offset: number;
  length: number;
}

export interface PackMeta {
  format: string;
  version: number;
  source: string;
  built_at: string;
  lat0: number;
  lon0: number;
  coord_scale: number;
  bbox: [number, number, number, number];
  counts: { nodes: number; edges: number; geoms: number; verts: number; bans: number };
  highway_classes: string[];
  signal_delay_s: number;
  stats?: Record<string, number>;
  sections: SectionInfo[];
}

export interface RoadPack {
  meta: PackMeta;
  proj: LocalProjection;
  nNodes: number;
  nEdges: number;
  nGeoms: number;
  /** Vertex offsets per geometry (g + 1). */
  geomPtr: Uint32Array;
  /** Projected vertex coordinates (metres) and distance from their geometry's start. */
  vx: Float64Array;
  vy: Float64Array;
  vs: Float64Array;
  vertGeom: Uint32Array;
  geomLen: Float64Array;
  /** Directed edge travelling each geometry forwards / backwards, or -1. */
  geomFwd: Int32Array;
  geomRev: Int32Array;
  /** Node at each geometry's first / last vertex. */
  geomU: Int32Array;
  geomV: Int32Array;
  nodeX: Float64Array;
  nodeY: Float64Array;
  /** Outgoing edges of node v are outPtr[v] .. outPtr[v + 1] - 1 (edges are sorted by source). */
  outPtr: Uint32Array;
  edgeSrc: Uint32Array;
  edgeDst: Uint32Array;
  edgeGeom: Uint32Array;
  edgeRev: Uint8Array;
  /** Free-flow seconds including signal delay. */
  edgeTime: Float32Array;
  edgeClass: Uint8Array;
  /** Compass heading leaving the start node / arriving at the end node, degrees. */
  edgeH0: Float32Array;
  edgeH1: Float32Array;
  /** The same geometry travelled the other way, or -1. */
  twin: Int32Array;
  /** Keys from * nEdges + to of forbidden transitions; `hasBan` flags their `from` edges. */
  banned: Set<number>;
  hasBan: Uint8Array;
  /** Fastest speed in the pack (m/s): keeps the A* heuristic admissible. */
  maxSpeed: number;
  /** Each geometry's road label: an index into `labels` (0: none). */
  geomLabel: Uint32Array;
  /** "name\x1fref\x1fdestination" per label; labels[0] is "". See pipeline/osm_graph.py, road_label. */
  labels: string[];
  /** GEOM_ROUNDABOUT and friends, per geometry. */
  geomFlags: Uint8Array;
}

/** geom_flags: the geometry is part of a roundabout. */
export const GEOM_ROUNDABOUT = 1;

const MAGIC = "FWR1";
const VERSION = 1;
const CTORS = {
  uint8: Uint8Array, uint16: Uint16Array, int32: Int32Array, uint32: Uint32Array,
  float32: Float32Array, float64: Float64Array,
} as const;

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
  throw new Error("road packs are little-endian; this platform is not");
}

/** `buf` must be a whole ArrayBuffer (offset 0), so 8-aligned sections stay aligned. */
export function decodePack(buf: ArrayBuffer): RoadPack {
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== MAGIC) throw new Error(`not a road pack (magic ${JSON.stringify(magic)})`);
  const view = new DataView(buf);
  const version = view.getUint32(4, true);
  if (version !== VERSION) throw new Error(`road pack version ${version}, expected ${VERSION}`);
  const headerLen = view.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, headerLen))) as PackMeta;
  const base = 12 + headerLen;
  const byName = new Map(meta.sections.map((s) => [s.name, s]));
  const optional = <K extends DType>(name: string, dtype: K): InstanceType<(typeof CTORS)[K]> | null => {
    const s = byName.get(name);
    if (!s) return null;
    if (s.dtype !== dtype) throw new Error(`road pack: section ${name} is ${s.dtype}, expected ${dtype}`);
    return new CTORS[dtype](buf, base + s.offset, s.length) as InstanceType<(typeof CTORS)[K]>;
  };
  const section = <K extends DType>(name: string, dtype: K): InstanceType<(typeof CTORS)[K]> => {
    const s = optional(name, dtype);
    if (!s) throw new Error(`road pack: missing ${dtype} section ${name}`);
    return s;
  };

  const proj = new LocalProjection(meta.lat0, meta.lon0);
  const geomPtr = section("geom_ptr", "uint32");
  const dlon = section("geom_dlon", "int32");
  const dlat = section("geom_dlat", "int32");
  const outPtr = section("node_out_ptr", "uint32");
  const edgeDst = section("edge_dst", "uint32");
  const edgeGeom = section("edge_geom", "uint32");
  const edgeRev = section("edge_flags", "uint8");
  const edgeTime = section("edge_time", "float32");
  const edgeClass = section("edge_class", "uint8");
  const h0 = section("edge_h0", "uint16");
  const h1 = section("edge_h1", "uint16");
  const banFrom = section("ban_from", "uint32");
  const banTo = section("ban_to", "uint32");

  const nGeoms = geomPtr.length - 1;
  const nVerts = dlon.length;
  const nNodes = outPtr.length - 1;
  const nEdges = edgeDst.length;
  const scale = meta.coord_scale;
  const labelBytes = optional("labels", "uint8");
  const labels = labelBytes ? new TextDecoder().decode(labelBytes).split("\0").slice(0, -1) : [""];
  const geomLabel = optional("geom_label", "uint32") ?? new Uint32Array(nGeoms);
  const geomFlags = optional("geom_flags", "uint8") ?? new Uint8Array(nGeoms);
  if (geomLabel.length !== nGeoms || geomFlags.length !== nGeoms || geomLabel.some((i) => i >= labels.length)) {
    throw new Error("road pack: road labels don't match the geometry");
  }

  const vx = new Float64Array(nVerts);
  const vy = new Float64Array(nVerts);
  const vs = new Float64Array(nVerts);
  const vertGeom = new Uint32Array(nVerts);
  const geomLen = new Float64Array(nGeoms);
  for (let g = 0; g < nGeoms; g++) {
    let lon = 0;
    let lat = 0;
    for (let k = geomPtr[g]; k < geomPtr[g + 1]; k++) {
      const first = k === geomPtr[g];
      lon = first ? dlon[k] : lon + dlon[k];
      lat = first ? dlat[k] : lat + dlat[k];
      vx[k] = proj.x(lon / scale);
      vy[k] = proj.y(lat / scale);
      vertGeom[k] = g;
      vs[k] = first ? 0 : vs[k - 1] + Math.hypot(vx[k] - vx[k - 1], vy[k] - vy[k - 1]);
    }
    geomLen[g] = vs[geomPtr[g + 1] - 1];
  }

  const edgeSrc = new Uint32Array(nEdges);
  for (let v = 0; v < nNodes; v++) edgeSrc.fill(v, outPtr[v], outPtr[v + 1]);
  const geomFwd = new Int32Array(nGeoms).fill(-1);
  const geomRev = new Int32Array(nGeoms).fill(-1);
  const geomU = new Int32Array(nGeoms);
  const geomV = new Int32Array(nGeoms);
  const nodeX = new Float64Array(nNodes);
  const nodeY = new Float64Array(nNodes);
  const edgeH0 = new Float32Array(nEdges);
  const edgeH1 = new Float32Array(nEdges);
  let maxSpeed = 0;
  for (let e = 0; e < nEdges; e++) {
    const g = edgeGeom[e];
    if (edgeRev[e]) geomRev[g] = e;
    else geomFwd[g] = e;
    geomU[g] = edgeRev[e] ? edgeDst[e] : edgeSrc[e];
    geomV[g] = edgeRev[e] ? edgeSrc[e] : edgeDst[e];
    const end = edgeRev[e] ? geomPtr[g] : geomPtr[g + 1] - 1;
    nodeX[edgeDst[e]] = vx[end];
    nodeY[edgeDst[e]] = vy[end];
    edgeH0[e] = h0[e] / 100;
    edgeH1[e] = h1[e] / 100;
    if (edgeTime[e] > 0) maxSpeed = Math.max(maxSpeed, geomLen[g] / edgeTime[e]);
  }
  const twin = new Int32Array(nEdges);
  for (let e = 0; e < nEdges; e++) twin[e] = edgeRev[e] ? geomFwd[edgeGeom[e]] : geomRev[edgeGeom[e]];

  const banned = new Set<number>();
  const hasBan = new Uint8Array(nEdges);
  for (let i = 0; i < banFrom.length; i++) {
    banned.add(banFrom[i] * nEdges + banTo[i]);
    hasBan[banFrom[i]] = 1;
  }

  return {
    meta, proj, nNodes, nEdges, nGeoms, geomPtr, vx, vy, vs, vertGeom, geomLen, geomFwd, geomRev,
    geomU, geomV, nodeX, nodeY, outPtr, edgeSrc, edgeDst, edgeGeom, edgeRev, edgeTime, edgeClass, edgeH0, edgeH1,
    twin, banned, hasBan, maxSpeed, geomLabel, labels, geomFlags,
  };
}
