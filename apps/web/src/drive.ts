// Position and heading along a route polyline, measured in the road pack's own projection so
// "metres along the route" agrees with the router's alert distances.
import { compassBearing, type LocalProjection } from "@flockwatch/router";

import type { LonLat } from "./protocol.ts";

export interface Fix {
  lon: number;
  lat: number;
  heading: number;
  distM: number;
}

export class Polyline {
  readonly lengthM: number;
  private readonly proj: LocalProjection;
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  private readonly cum: Float64Array;

  constructor(coords: readonly LonLat[], proj: LocalProjection) {
    this.proj = proj;
    this.x = Float64Array.from(coords, ([lon]) => proj.x(lon));
    this.y = Float64Array.from(coords, ([, lat]) => proj.y(lat));
    this.cum = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) {
      this.cum[i] = this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.y[i] - this.y[i - 1]);
    }
    this.lengthM = this.cum[coords.length - 1] ?? 0;
  }

  /**
   * Where a GPS fix falls on the line: metres along it, and how far off it the fix is. The nearest
   * point wins, except that going back more than `slackM` behind `fromM` costs extra, so a fix
   * that's as close to a stretch already driven (an out-and-back, a loop) stays on the one ahead.
   */
  match(lon: number, lat: number, fromM = 0, slackM = 40): { distM: number; offM: number } {
    const px = this.proj.x(lon), py = this.proj.y(lat);
    let distM = 0, offM = Infinity, best = Infinity;
    for (let i = 1; i < this.cum.length; i++) {
      const x0 = this.x[i - 1], y0 = this.y[i - 1];
      const dx = this.x[i] - x0, dy = this.y[i] - y0;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
      const off = Math.hypot(x0 + t * dx - px, y0 + t * dy - py);
      const along = this.cum[i - 1] + t * (this.cum[i] - this.cum[i - 1]);
      const cost = off + Math.max(0, fromM - slackM - along);
      if (cost < best) [best, distM, offM] = [cost, along, off];
    }
    return { distM, offM };
  }

  at(distM: number): Fix {
    const d = Math.min(Math.max(distM, 0), this.lengthM);
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const seg = this.cum[hi] - this.cum[lo];
    const t = seg > 0 ? (d - this.cum[lo]) / seg : 0;
    const x = this.x[lo] + t * (this.x[hi] - this.x[lo]);
    const y = this.y[lo] + t * (this.y[hi] - this.y[lo]);
    return {
      lon: this.proj.lon(x), lat: this.proj.lat(y), distM: d,
      heading: compassBearing(this.x[hi] - this.x[lo], this.y[hi] - this.y[lo]),
    };
  }
}
