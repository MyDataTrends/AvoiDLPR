// Checks a freshly built road pack before it replaces the one people have: it has to decode, be
// about the size of the live pack, and route a sample of trips in about the same times. It also
// measures how much changed (the share of road edges that differ), which the data build uses to
// decide whether a change is worth a download. bin/verify.ts runs it from the build; a pack that
// fails is held back and the area keeps its live pack.
import type { CameraRecord } from "./geo.ts";
import { Router } from "./router.ts";

export interface PackSummary {
  nodes: number;
  edges: number;
  bbox: [number, number, number, number];
}

export interface Verdict {
  ok: boolean;
  /** Why it failed, in words; empty when it passed. */
  reasons: string[];
  new: PackSummary | null;
  old: PackSummary | null;
  /** New edge count over the live one's. */
  edgeRatio: number | null;
  /** Share of directed road edges (by both ends and travel time) in one pack but not the other, 0..1. */
  changed: number | null;
  trips: {
    tried: number;
    routedNew: number;
    /** Of the trips tried, how many the live pack routes. */
    routedOld: number | null;
    /** Median of new / live travel time, over trips both packs route. */
    medianRatio: number | null;
    /** Trips whose time changed by more than `outlierFactor` either way. */
    outliers: number | null;
  };
}

export const LIMITS = {
  /** The new pack's edge count, relative to the live one's. */
  minEdgeRatio: 0.85,
  maxEdgeRatio: 1.2,
  /** Sample trips, each between these straight-line distances (metres). */
  trips: 40,
  minTripM: 2_000,
  maxTripM: 30_000,
  /** Median new / live travel time over the sample. */
  minMedianRatio: 0.85,
  maxMedianRatio: 1.15,
  /** A trip whose time changed by more than this factor either way is an outlier... */
  outlierFactor: 1.5,
  /** ...and more than this share of outliers fails the pack. */
  maxOutliers: 0.1,
  /** Share of sampled trips the new pack may fail to route where the live one could. */
  maxLostTrips: 0.05,
  /** A pack this small isn't an area: something went wrong upstream. */
  minEdges: 100,
};
export type Limits = typeof LIMITS;

/** Deterministic random numbers in [0, 1), so a check is repeatable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function summary(r: Router): PackSummary {
  return { nodes: r.pack.nNodes, edges: r.pack.nEdges, bbox: r.pack.meta.bbox as [number, number, number, number] };
}

/**
 * Every directed edge as "start>end:time", ends in micro-degrees (the pack's own resolution, so
 * two packs with different projection origins agree) and time in tenths of a second.
 */
function edgeKeys(r: Router): Map<string, number> {
  const p = r.pack;
  const lon = (v: number) => Math.round(p.proj.lon(p.nodeX[v]) * 1e6);
  const lat = (v: number) => Math.round(p.proj.lat(p.nodeY[v]) * 1e6);
  const keys = new Map<string, number>();
  for (let e = 0; e < p.nEdges; e++) {
    const s = p.edgeSrc[e], d = p.edgeDst[e];
    const key = `${lon(s)},${lat(s)}>${lon(d)},${lat(d)}:${Math.round(p.edgeTime[e] * 10)}`;
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return keys;
}

/** Share of edges in one multiset and not the other. */
export function changedShare(a: Router, b: Router): number {
  const ka = edgeKeys(a), kb = edgeKeys(b);
  let diff = 0;
  for (const [k, n] of ka) diff += Math.abs(n - (kb.get(k) ?? 0));
  for (const [k, n] of kb) if (!ka.has(k)) diff += n;
  return diff / Math.max(1, a.pack.nEdges + b.pack.nEdges);
}

/** Sample trip ends: pairs of the new pack's intersections a sensible driving distance apart. */
function sampleTrips(r: Router, limits: Limits, seed: number): [number, number, number, number][] {
  const p = r.pack, rand = mulberry32(seed), trips: [number, number, number, number][] = [];
  for (let attempt = 0; trips.length < limits.trips && attempt < limits.trips * 50; attempt++) {
    const u = Math.floor(rand() * p.nNodes), v = Math.floor(rand() * p.nNodes);
    const d = Math.hypot(p.nodeX[u] - p.nodeX[v], p.nodeY[u] - p.nodeY[v]);
    if (d < limits.minTripM || d > limits.maxTripM) continue;
    trips.push([p.proj.lon(p.nodeX[u]), p.proj.lat(p.nodeY[u]), p.proj.lon(p.nodeX[v]), p.proj.lat(p.nodeY[v])]);
  }
  return trips;
}

function travelTime(r: Router, [lon0, lat0, lon1, lat1]: [number, number, number, number]): number | null {
  const a = r.snap(lon0, lat0), b = r.snap(lon1, lat1);
  return a && b ? (r.route(a, b, { lambda: 0 })?.timeS ?? null) : null;
}

/**
 * Check `fresh` (a road pack's bytes, not gzipped) against `live` (the published one, if any).
 * `cameras`, when given, are loaded too, so a feed that breaks the exposure step fails here.
 */
export function verifyPack(fresh: ArrayBuffer, live: ArrayBuffer | null, opts: {
  cameras?: readonly CameraRecord[]; limits?: Partial<Limits>; seed?: number;
} = {}): Verdict {
  const limits = { ...LIMITS, ...opts.limits };
  const verdict: Verdict = {
    ok: false, reasons: [], new: null, old: null, edgeRatio: null, changed: null,
    trips: { tried: 0, routedNew: 0, routedOld: null, medianRatio: null, outliers: null },
  };
  let next: Router;
  try {
    next = Router.fromBuffer(fresh, opts.cameras ?? []);
  } catch (err) {
    verdict.reasons.push(`the new pack doesn't load: ${err instanceof Error ? err.message : String(err)}`);
    return verdict;
  }
  verdict.new = summary(next);
  if (next.pack.nEdges < limits.minEdges) verdict.reasons.push(`the new pack has only ${next.pack.nEdges} road edges`);

  let prev: Router | null = null;
  if (live) {
    try {
      prev = Router.fromBuffer(live, []);
      verdict.old = summary(prev);
    } catch {
      prev = null; // a live pack that won't load is no yardstick; judge the new one alone
    }
  }

  const trips = sampleTrips(next, limits, opts.seed ?? 1);
  verdict.trips.tried = trips.length;
  const ratios: number[] = [];
  let lost = 0;
  for (const trip of trips) {
    const t1 = travelTime(next, trip);
    if (t1 !== null) verdict.trips.routedNew++;
    if (!prev) continue;
    const t0 = travelTime(prev, trip);
    if (t0 !== null) verdict.trips.routedOld = (verdict.trips.routedOld ?? 0) + 1;
    if (t0 !== null && t1 === null) lost++;
    if (t0 !== null && t1 !== null && t0 > 0) ratios.push(t1 / t0);
  }
  if (!prev && trips.length && verdict.trips.routedNew < trips.length * (1 - limits.maxLostTrips)) {
    verdict.reasons.push(`only ${verdict.trips.routedNew} of ${trips.length} sample trips route`);
  }

  if (prev) {
    verdict.edgeRatio = next.pack.nEdges / Math.max(1, prev.pack.nEdges);
    if (verdict.edgeRatio < limits.minEdgeRatio || verdict.edgeRatio > limits.maxEdgeRatio) {
      verdict.reasons.push(`the road edge count changed by ${pct(verdict.edgeRatio - 1)} (${prev.pack.nEdges} to ${next.pack.nEdges})`);
    }
    verdict.changed = changedShare(next, prev);
    verdict.trips.routedOld ??= 0;
    if (trips.length && lost > trips.length * limits.maxLostTrips) {
      verdict.reasons.push(`${lost} of ${trips.length} sample trips route on the live pack but not the new one`);
    }
    if (ratios.length) {
      const sorted = [...ratios].sort((a, b) => a - b);
      verdict.trips.medianRatio = sorted[Math.floor(sorted.length / 2)];
      verdict.trips.outliers = ratios.filter((r) => r > limits.outlierFactor || r < 1 / limits.outlierFactor).length;
      if (verdict.trips.medianRatio < limits.minMedianRatio || verdict.trips.medianRatio > limits.maxMedianRatio) {
        verdict.reasons.push(`sample trips take ${pct(verdict.trips.medianRatio - 1)} as long on the new pack (median)`);
      }
      if (verdict.trips.outliers > ratios.length * limits.maxOutliers) {
        verdict.reasons.push(`${verdict.trips.outliers} of ${ratios.length} sample trips changed time by more than ${limits.outlierFactor}x`);
      }
    }
  }
  verdict.ok = verdict.reasons.length === 0;
  return verdict;
}

function pct(x: number): string {
  return `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}%`;
}
