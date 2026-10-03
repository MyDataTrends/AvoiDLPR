/**
 * Uniform grid over road segments (vertex k -> k + 1 within one geometry). Serves snapping
 * and the exposure pass, which only ever looks a few cells around a point.
 */

import type { RoadPack } from "./pack.ts";

export class SegmentGrid {
  readonly cellM: number;
  private readonly pack: RoadPack;
  private readonly minX: number;
  private readonly minY: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly cellPtr: Uint32Array;
  private readonly items: Uint32Array;
  private readonly stamp: Uint32Array;
  private generation = 0;

  constructor(pack: RoadPack, cellM = 100) {
    this.pack = pack;
    this.cellM = cellM;
    const { vx, vy, vertGeom } = pack;
    const n = vx.length;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < n; k++) {
      minX = Math.min(minX, vx[k]);
      minY = Math.min(minY, vy[k]);
      maxX = Math.max(maxX, vx[k]);
      maxY = Math.max(maxY, vy[k]);
    }
    this.minX = minX;
    this.minY = minY;
    this.nx = Math.floor((maxX - minX) / cellM) + 1;
    this.ny = Math.floor((maxY - minY) / cellM) + 1;

    // Two passes: count the cells each segment's bounding box covers, then fill.
    const counts = new Uint32Array(this.nx * this.ny + 1);
    const visit = (k: number, fn: (cell: number) => void) => {
      const x0 = this.col(Math.min(vx[k], vx[k + 1])), x1 = this.col(Math.max(vx[k], vx[k + 1]));
      const y0 = this.row(Math.min(vy[k], vy[k + 1])), y1 = this.row(Math.max(vy[k], vy[k + 1]));
      for (let r = y0; r <= y1; r++) for (let c = x0; c <= x1; c++) fn(r * this.nx + c);
    };
    for (let k = 0; k + 1 < n; k++) if (vertGeom[k] === vertGeom[k + 1]) visit(k, (cell) => counts[cell + 1]++);
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    this.cellPtr = counts;
    this.items = new Uint32Array(counts[counts.length - 1]);
    const fill = counts.slice(0, -1);
    for (let k = 0; k + 1 < n; k++) if (vertGeom[k] === vertGeom[k + 1]) visit(k, (cell) => { this.items[fill[cell]++] = k; });
    this.stamp = new Uint32Array(n);
  }

  private col(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cellM)));
  }

  private row(y: number): number {
    return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.minY) / this.cellM)));
  }

  /** Calls fn(k) once per segment whose bounding box may lie within `r` of (x, y). */
  forEachNear(x: number, y: number, r: number, fn: (k: number) => void): void {
    if (++this.generation === 0xffffffff) {
      this.stamp.fill(0);
      this.generation = 1;
    }
    const gen = this.generation;
    const x0 = this.col(x - r), x1 = this.col(x + r), y0 = this.row(y - r), y1 = this.row(y + r);
    for (let row = y0; row <= y1; row++) {
      for (let c = x0; c <= x1; c++) {
        const cell = row * this.nx + c;
        for (let i = this.cellPtr[cell]; i < this.cellPtr[cell + 1]; i++) {
          const k = this.items[i];
          if (this.stamp[k] === gen) continue;
          this.stamp[k] = gen;
          fn(k);
        }
      }
    }
  }

  /**
   * Nearest point on any segment within `maxDistM`: its segment, the fraction along it and
   * the distance. Returns null when nothing is that close.
   */
  nearest(x: number, y: number, maxDistM: number): { k: number; t: number; dist: number } | null {
    const { vx, vy } = this.pack;
    let best: { k: number; t: number; dist: number } | null = null;
    this.forEachNear(x, y, maxDistM, (k) => {
      const dx = vx[k + 1] - vx[k], dy = vy[k + 1] - vy[k];
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - vx[k]) * dx + (y - vy[k]) * dy) / len2)) : 0;
      const dist = Math.hypot(vx[k] + t * dx - x, vy[k] + t * dy - y);
      if (dist <= maxDistM && (best === null || dist < best.dist)) best = { k, t, dist };
    });
    return best;
  }
}
