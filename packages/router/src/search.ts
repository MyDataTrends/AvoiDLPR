/**
 * Edge-based A*. Search states are directed edges, so turn costs, turn restrictions and
 * "don't charge a zone twice" can all depend on the (incoming, outgoing) edge pair.
 *
 * Moving from edge e onto edge f costs
 *
 *     turn(e, f) + time(f) + lambda * (sites logging f that weren't already holding the
 *                                      vehicle at the end of e, each by its weight)
 *
 * so lambda is seconds of driving per avoided capture-site entry, and a zone that spans an
 * intersection is charged once. A weight is 1, or split between a zone and its ring
 * (exposure.ts, `withRings`), so a ring alone costs a share of a capture. dist[e] is the cost to reach the END of e. The heuristic is
 * the straight line from e's end node to the destination at the pack's top speed: admissible
 * and consistent, because every edge takes at least length / maxSpeed and every other term
 * is non-negative. Each edge is therefore settled once, and the first time the queue's
 * minimum reaches the best arrival found, that arrival is optimal.
 *
 * U-turns are refused except at dead ends; US right-hand traffic makes left turns dearer.
 */

import type { Exposure } from "./exposure.ts";
import { wrap180 } from "./geo.ts";
import { MinHeap } from "./heap.ts";
import type { RoadPack } from "./pack.ts";

/** A point snapped onto the road network. */
export interface Endpoint {
  geom: number;
  /** Metres from the geometry's first vertex. */
  s: number;
  /** Snapped position, projected metres. */
  x: number;
  y: number;
  /** How far the requested point was from the road. */
  offsetM: number;
}

export interface SearchPath {
  cost: number;
  /** Directed edges in travel order. */
  edges: number[];
  /** Metres into the first edge where the route begins / into the last where it ends. */
  startOffset: number;
  endOffset: number;
}

/** An endpoint this close to a geometry's end stands on that intersection. */
export const NODE_EPS_M = 0.5;

export const TURN_COST_S = { slight: 2, right: 4, left: 9, sharp: 15 } as const;

/** Seconds to turn from heading hIn onto hOut (compass degrees; right turns are positive). */
export function turnCost(hIn: number, hOut: number): number {
  const d = wrap180(hOut - hIn);
  const a = Math.abs(d);
  if (a <= 30) return 0;
  if (a <= 60) return TURN_COST_S.slight;
  if (a > 150) return TURN_COST_S.sharp;
  return d > 0 ? TURN_COST_S.right : TURN_COST_S.left;
}

export class EdgeSearch {
  exposure: Exposure;
  /** Edges expanded by the last run. */
  expanded = 0;
  private readonly pack: RoadPack;
  private readonly dist: Float64Array;
  private readonly parent: Int32Array;
  private readonly seen: Uint32Array;
  private generation = 0;
  private readonly heap = new MinHeap(1 << 14);

  constructor(pack: RoadPack, exposure: Exposure) {
    this.pack = pack;
    this.exposure = exposure;
    this.dist = new Float64Array(pack.nEdges);
    this.parent = new Int32Array(pack.nEdges);
    this.seen = new Uint32Array(pack.nEdges);
  }

  /** Cheapest path for this lambda, or null if the destination is unreachable. */
  run(from: Endpoint, to: Endpoint, lambda: number, heuristic = true): SearchPath | null {
    const { pack, dist, parent, seen, heap } = this;
    const { edgeDst, edgeRev, outPtr, twin, hasBan, banned, edgeTime, edgeH0, edgeH1, nodeX, nodeY, geomLen,
      geomFwd, geomRev, nEdges } = pack;
    if (++this.generation === 0xffffffff) {
      seen.fill(0);
      this.generation = 1;
    }
    const gen = this.generation;
    this.expanded = 0;
    heap.clear();

    const inv = heuristic ? 1 / pack.maxSpeed : 0;
    const h = (e: number) => {
      const dx = nodeX[edgeDst[e]] - to.x, dy = nodeY[edgeDst[e]] - to.y;
      return inv * Math.sqrt(dx * dx + dy * dy);
    };
    const offer = (f: number, cost: number, from: number) => {
      if (seen[f] === gen && dist[f] <= cost) return;
      seen[f] = gen;
      dist[f] = cost;
      parent[f] = from;
      heap.push(cost + h(f), f);
    };

    const L0 = geomLen[from.geom], L1 = geomLen[to.geom];
    const originNode = nodeAt(pack, from);
    const destNode = nodeAt(pack, to);
    const destF = destNode < 0 ? geomFwd[to.geom] : -1;
    const destR = destNode < 0 ? geomRev[to.geom] : -1;
    const startOffset = (e: number) => (originNode >= 0 ? 0 : edgeRev[e] ? L0 - from.s : from.s);
    const endOffset = (f: number) => (edgeRev[f] ? L1 - to.s : to.s);

    // best: follow parents from `tail`, then append `extra` (if >= 0), stopping at `endOff`.
    let best = { cost: Infinity, tail: -1, extra: -1, endOff: 0 };
    if (originNode >= 0 && originNode === destNode) return { cost: 0, edges: [], startOffset: 0, endOffset: 0 };

    if (originNode >= 0) {
      for (let f = outPtr[originNode]; f < outPtr[originNode + 1]; f++) {
        offer(f, edgeTime[f] + (lambda > 0 ? lambda * this.sitesBetween(f, 0, Infinity) : 0), -1);
        if (f === destF || f === destR) {
          const b = endOffset(f);
          const cost = edgeTime[f] * (b / L1) + (lambda > 0 ? lambda * this.sitesBetween(f, 0, b) : 0);
          if (cost < best.cost) best = { cost, tail: -1, extra: f, endOff: b };
        }
      }
    } else {
      for (const e of [geomFwd[from.geom], geomRev[from.geom]]) {
        if (e < 0) continue;
        const a = startOffset(e);
        offer(e, edgeTime[e] * ((L0 - a) / L0) + (lambda > 0 ? lambda * this.sitesBetween(e, a, Infinity) : 0), -1);
        if ((e === destF || e === destR) && endOffset(e) >= a) {
          const b = endOffset(e);
          const cost = edgeTime[e] * ((b - a) / L0) + (lambda > 0 ? lambda * this.sitesBetween(e, a, b) : 0);
          if (cost < best.cost) best = { cost, tail: -1, extra: e, endOff: b };
        }
      }
    }

    while (heap.size > 0) {
      const key = heap.peekKey();
      if (key >= best.cost) break;
      const e = heap.pop();
      const de = dist[e];
      if (key > de + h(e)) continue; // superseded by a cheaper offer
      this.expanded++;
      const v = edgeDst[e];
      if (v === destNode) {
        if (de < best.cost) best = { cost: de, tail: e, extra: -1, endOff: geomLen[pack.edgeGeom[e]] };
        continue;
      }
      const lo = outPtr[v], hi = outPtr[v + 1];
      for (let f = lo; f < hi; f++) {
        if (f === twin[e] && hi - lo > 1) continue;
        if (hasBan[e] && banned.has(e * nEdges + f)) continue;
        const base = de + turnCost(edgeH1[e], edgeH0[f]);
        if (f === destF || f === destR) {
          const b = endOffset(f);
          const cost = base + edgeTime[f] * (b / L1) + (lambda > 0 ? lambda * this.newSites(e, f, b) : 0);
          if (cost < best.cost) best = { cost, tail: e, extra: f, endOff: b };
        }
        offer(f, base + edgeTime[f] + (lambda > 0 ? lambda * this.newSites(e, f, Infinity) : 0), e);
      }
    }
    if (best.cost === Infinity) return null;

    const edges: number[] = [];
    for (let e = best.tail; e >= 0; e = parent[e]) edges.push(e);
    edges.reverse();
    if (best.extra >= 0) edges.push(best.extra);
    return { cost: best.cost, edges, startOffset: startOffset(edges[0]), endOffset: best.endOff };
  }

  /** Sites logging edge f anywhere in [a, b] (metres from its start), by weight. */
  private sitesBetween(f: number, a: number, b: number): number {
    const { ptr, entry, exit, weight } = this.exposure;
    let n = 0;
    for (let k = ptr[f]; k < ptr[f + 1]; k++) if (entry[k] <= b && exit[k] >= a) n += weight[k];
    return n;
  }

  /** Sites logging f up to `upTo` metres in, minus those still holding the vehicle as e ends, by weight. */
  private newSites(e: number, f: number, upTo: number): number {
    const { ptr, site, entry, atEnd, weight } = this.exposure;
    let n = 0;
    for (let k = ptr[f]; k < ptr[f + 1]; k++) {
      if (entry[k] > upTo) continue;
      let carried = false;
      for (let q = ptr[e]; q < ptr[e + 1]; q++) {
        if (atEnd[q] && site[q] === site[k]) {
          carried = true;
          break;
        }
      }
      if (!carried) n += weight[k];
    }
    return n;
  }
}

/** The node an endpoint stands on, or -1 when it is mid-geometry. */
export function nodeAt(pack: RoadPack, p: Endpoint): number {
  if (p.s <= NODE_EPS_M) return pack.geomU[p.geom];
  if (p.s >= pack.geomLen[p.geom] - NODE_EPS_M) return pack.geomV[p.geom];
  return -1;
}
